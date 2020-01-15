const qiniu = require('qiniu')
const path = require('path')
const Glob = require("glob").Glob
const chalk = require('chalk')
const fs = require('fs')
const dotEnv = require('dotenv')
const singleLineLog = require('single-line-log').stdout

const errorStyle = chalk.red
const successStyle = chalk.green
const infoStyle = chalk.blue
const LOGGER = 'simple-qiniu-upload'

const zone = {
    z0: qiniu.zone.Zone_z0,
    z1: qiniu.zone.Zone_z1,
    z2: qiniu.zone.Zone_z2,
    na0: qiniu.zone.Zone_na0,
}

function loadEnv(envPath) {
    const result = dotEnv.config({
        path: envPath
    })

    if (result.error) {
        throw result.error
    }

    return result.parsed
}

const DEFAULTS = {
    debug: false,
    accessKey: '', // set in .qiniu file
    secretKey: '', // set in .qiniu file
    cwd: process.cwd(),
    envFile: '.qiniu',
    base: 'dist',
    output: 'qiniu-upload.json',
    glob: 'dist/**',
    globIgnore: [
        'dist/!(static)/**'
    ],
    bucket: 'static',
    overrides: false,
    parallelCount: 2,
    zone: zone.z0
}

class Uploader {
    constructor(config = {}) {
        let cwd = config.cwd || DEFAULTS.cwd
        let envFile = config.envFile === undefined ? DEFAULTS.envFile : config.envFile

        let env = {}
        if (envFile) {
            env = loadEnv(path.resolve(cwd, envFile))
        }

        this._config = { ...DEFAULTS, ...env, ...config }

        this._mac = new qiniu.auth.digest.Mac(this.config.accessKey, this.config.secretKey)
        this.showConfigInfo()

        this._bucketManager = null
    }

    showConfigInfo() {
        this._log('log', 'config: ')
        this._log('log', `      cwd: ${successStyle(this.config.cwd)}`)
        this._log('log', `      envFile: ${successStyle(this.config.envFile)}`)
        this._log('log', `      base: ${successStyle(this.config.base)}`)
        this._log('log', `      output: ${successStyle(this.config.output)}`)
        this._log('log', `      bucket: ${successStyle(this.config.bucket)}`)
        this._log('log', `      overrides: ${successStyle(this.config.overrides)}`)
    }

    resolveBase() {
        return path.resolve(this.config.cwd, this.config.base).replace(/\\/g, '/') + '/'
    }

    get config() {
        return this._config
    }

    get mac() {
        return this._mac
    }

    get bucketManager() {
        if (!this._bucketManager) {
            let config = new qiniu.conf.Config()
            config.zone = this.config.zone
            this._bucketManager = new qiniu.rs.BucketManager(this._mac, config);
        }

        return this._bucketManager
    }

    buildUploadToken(key) {
        let options = {
            scope: `${this.config.bucket}:${key}`,
            expires: 7200,
            insertOnly: this.config.overrides ? 0 : 1
        }
        return new qiniu.rs.PutPolicy(options).uploadToken(this.mac)
    }

    getWaitingUploadFiles() {
        return new Promise((resolve, reject) => {
            this._glob = new Glob(this.config.glob, {
                cwd: this.config.cwd,
                strict: true,
                absolute: true,
                nodir: true,
                ignore: this.config.globIgnore
            }, (err, files) => {
                if (err) {
                    if (!(err instanceof Error)) {
                        err = new Error(String(err))
                    }
                    this.error(errorStyle('unexpected error when getting upload files:'), errorStyle(err.stack))
                    return reject(err)
                }

                this.log(`find ${files.length} files to upload.`)
                resolve(files)
            })
        })
    }

    _debugLog(level, ...args) {
        if (this.config.debug) {
            this._log(level, ...args)
        }
    }

    _log(level, ...args) {
        console[level](chalk.blue(`[${LOGGER}]`), ...args)
    }

    log(...args) {
        this._debugLog('log', ...args)
    }

    error(...args) {
        this._debugLog('error', ...args)
    }


    async start({ } = {}) {
        let targetFiles = await this.getWaitingUploadFiles()
        let ended = []
        let results = {
            success: [],
            fail: []
        }
        let stats = {
            total: targetFiles.length,
            uploading: 0,
            success: 0,
            fail: 0
        }
        let end = () => {
            this.config.output &&
                fs.writeFile(path.resolve(this.config.cwd, this.config.output), JSON.stringify(results, null, '\t'), function (err) {
                    if (err) {
                        this.log(errorStyle(`error occured when save upload results. ${err.stack}`))
                    }
                });

            this.log(infoStyle('end<=============='))
        }
        let logStats = () => {
            if (this.config.debug) return
            singleLineLog((`${infoStyle('[' + LOGGER + ']')} total files: ${stats.total}, ${infoStyle('uploading:' + stats.uploading)}, ${
                successStyle('success:' + stats.success)
                }, ${
                errorStyle('fail:' + stats.fail)
                }\n`))
        }
        this.log(infoStyle('start============>'))

        return new Promise(resolve => {
            let run = () => {
                logStats()
                let file = targetFiles.pop();
                if (!file) {
                    ended.push(1)

                    if (ended.length === this.config.parallelCount) {
                        return resolve(end())
                    }

                    return
                }
                stats.uploading++

                this._createUploadTask(file).then(({ key }) => {
                    stats.uploading--
                    stats.success++
                    results.success.push({
                        file, key,
                        skipped: false
                    })
                    this.log(successStyle('upload success:'), file)
                }).catch(({ key, msg, stack }) => {
                    stats.uploading--
                    stats.fail++
                    results.fail.push({
                        file, key, msg
                    })
                    this.error(errorStyle(`upload error: ${file}`))
                    this.error('             ', errorStyle(stack))
                }).then(run)
            }

            let parallelCount = this.config.parallelCount
            while (parallelCount--) {
                run()
            }
        })
    }

    _createUploadTask(file) {
        return new Promise((resolve, reject) => {
            this.log('uploading:', file)
            let base = this.resolveBase()
            let key = file.replace(base, '')

            let config = new qiniu.conf.Config()
            config.zone = this.config.zone

            let formUploader = new qiniu.form_up.FormUploader(config)

            formUploader.putFile(this.buildUploadToken(key), key, file, undefined, function (respErr,
                respBody, respInfo) {
                if (respErr) {
                    return reject({
                        file,
                        key,
                        msg: respErr.message,
                        statck: respErr.stack
                    })
                }
                if (respInfo.statusCode == 200) {
                    resolve({
                        file,
                        key
                    })
                } else {
                    let msg = respInfo.data && respInfo.data.error || `code: ${respInfo.statusCode}`
                    reject({
                        file,
                        key,
                        msg: msg,
                        statusCode: respInfo.statusCode,
                        stack: msg
                    })
                }
            })
        })
    }

    fetchUploadedFiles({ limit = 50, prefix, storageAs = 'qiniu-file-list.json', append = false } = {}) {
        if (!prefix) return

        let files = []
        new Promise((resolve, reject) => {
            let run = ({ marker = '', pageIndex = 1 } = {}) => {
                this.log(`fetch files of page ${pageIndex}`)
                this._fetch({ limit, prefix, marker }).then(respBody => {
                    this.log(`             ${respBody.items.length} items founded.`)
                    respBody.items.forEach(function (item) {
                        files.push(item.key)
                    })

                    if (respBody.marker) {
                        run({ marker: respBody.marker, pageIndex: pageIndex + 1 })
                    } else {
                        resolve()
                    }
                }).catch(reject)
            }

            run()
        }).then(() => {
            this.deleteFiles(files)
            // fs.writeFile(path.resolve(this.config.cwd, storageAs), JSON.stringify(files, null, '\t'), function (err) {
            //     if (err) {
            //         this.log(errorStyle(`error occured when save file list. ${err.stack}`))
            //     }
            // })
        })
    }

    _fetch({ limit, prefix, marker }) {
        return new Promise((resolve, reject) => {
            this.bucketManager.listPrefix(this.config.bucket, { limit, prefix, marker }, function (err, respBody, respInfo) {
                if (err) {
                    console.log(err)
                    reject(err)
                }
                if (respInfo.statusCode == 200) {
                    resolve(respBody)
                } else {
                    reject(new Error(respInfo.statusCode))
                }
            })
        })
    }

    deleteFiles(files) {
        let del = () => {
            let operations = files.splice(0, 100).map(key => qiniu.rs.deleteOp(this.config.bucket, key))

            if (operations.length === 0) return

            this.bucketManager.batch(operations, function (err, respBody, respInfo) {
                if (err) {
                    this.error(errorStyle(err));
                } else {
                    // 200 is success, 298 is part success
                    if (parseInt(respInfo.statusCode / 100) == 2) {
                        respBody.forEach(function (item) {
                            if (item.code == 200) {
                                console.log(item.code + "\tsuccess");
                            } else {
                                console.log(item.code + "\t" + item.data.error);
                            }
                        });
                    } else {
                        console.log(respInfo.deleteusCode);
                        console.log(respBody);
                    }
                }
                del()
            })
        }

        del()
    }
}

Uploader.defaults = DEFAULTS

Uploader.zone = zone

module.exports = Uploader