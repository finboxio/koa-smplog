require('chai').should()
var test = require('ava').test
var st = require('supertest')
var koa = require('koa')
var fmt = require('util').format
var strip_ansi = require('strip-ansi')

var log = require('..')

test.beforeEach(function (t) {
  t.context.app = test_server()
})

test('the app should log nested requests made via the log request client', function (t) {
  return st(t.context.app.listen(0))
    .get('/')
    .expect(200, { response: { success: 'ok' } })
    .then(() => {
      var expected = [
        /\[info]  <─  GET \/nested 200 (.*)/,
        /\[info]   ┌  GET http:\/\/127.0.0.1:(\d+)\/nested 200 (.*)/,
        /\[info]  <┘  GET \/ 200 (.*)/
      ]
      t.context.app.stdout
        .split('\n')
        .filter(Boolean)
        .map(strip_ansi)
        .forEach((line, i) => {
          line.should.match(expected[i])
        })
    })
})

function test_server () {
  var app = koa()
  app.stdout = ''
  var logfn = function () { app.stdout += (fmt.apply(null, arguments) + '\n') }
  app.use(log({}, { log: logfn }))
  app.use(make_request)
  return app
}

function * make_request (next) {
  if (this.path === '/') {
    var url = this.href + 'nested'
    var [ res ] = yield (done) => this.log.request({ uri: url, method: 'GET' }, done)
    this.body = { response: res.body }
  } else if (this.path === '/nested') {
    this.body = { success: 'ok' }
  }
}