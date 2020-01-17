const Uploader = require('./src/index')

new Uploader({
    debug: true
})
.fetchUploadedFiles({prefix: 'some/0.1.1/'})
.then(uploader => {
    uploader.batchDelFiles()
})
