const Uploader = require('./src/index')

new Uploader({
    debug: true
}).fetchUploadedFiles({limit: 50, prefix: 'static/'})

