var { beforeEach, serial: test } = require('ava')
var st = require('supertest')
var koa = require('koa')
var fmt = require('util').format
var fs = require('fs')
var path = require('path')
var intercept = require('intercept-stdout')

var log = require('..')

beforeEach(function (t) {
  t.context.app = test_server()
})

test('the app should log the response size of streamed data', function (t) {
  return st(t.context.app)
    .get('/')
    .expect(200)
    .then((res) => {
      t.is(new Buffer(res.body).toString(), '200\n')
      t.regex(t.context.app.stdout.split('\n')[0], /"response_size_bytes":4/)
    })
})

function test_server () {
  var app = koa()
  app.use(log({}))
  app.use(send_stream)
  var server = app.listen()
  var restore = intercept((msg) => {
    server.stdout += msg.replace(/\n$/, '')
    return ''
  })
  server.stdout = ''
  server.on('close', () => restore())
  return server
}

function * send_stream (next) {
  this.body = fs.createReadStream(path.join(__dirname, 'stream.txt'))
}
