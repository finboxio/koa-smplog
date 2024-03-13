var { serial: test, afterEach } = require('ava')
var st = require('supertest')
var koa = require('koa')
var fmt = require('util').format
var strip = require('strip-ansi')
var intercept = require('intercept-stdout')

var log = require('..')
const { resolve } = require('path')

var restore
afterEach(() => restore && restore())

test('the app should log uncaught errors', function (t) {
  const app = test_server()
  return st(app)
    .get('/throw')
    .expect(500)
    .then(() => app.close())
    .then(() => {
      var lines = app.stdout
        .split('\n')
        .filter(Boolean)
        .filter((s) => !s.match(/DeprecationWarning/))
        .map(parse_line)
      t.is(lines[0].meta.error.message, 'this is an error')
      t.is(lines[0].meta.error.name, 'Error')
      t.is(lines[0].meta.error.prop1, 'error-prop')
      t.is(lines[0].meta.error.longline.length, 255)
      t.falsy(lines[0].meta.error.nested)
      t.falsy(lines[0].meta.error.toonested)
    })
})

test('the app should use custom error formatters', function (t) {
  const app = test_server({ format_error: (err) => ({ name: err.name }) })
  return st(app)
    .get('/throw')
    .expect(500)
    .then(() => app.close())
    .then(() => {
      var lines = app.stdout
        .split('\n')
        .filter(Boolean)
        .filter((s) => !s.match(/DeprecationWarning/))
        .map(parse_line)

      t.deepEqual(lines[0].meta.error, { name: 'Error' })
    })
})

test('the app should log client aborts', function (t) {
  const app = test_server()
  return st(app)
    .get('/delay')
    .timeout(100)
    .catch(() => new Promise(resolve  => setTimeout(resolve, 1000)))
    .then(() => app.close())
    .then(() => {
      var lines = app.stdout
        .split('\n')
        .filter(Boolean)
        .filter((s) => !s.match(/DeprecationWarning/))
        .map(parse_line)
      t.regex(lines[0].message, /x─  GET \/delay 499/)
      t.is(lines[0].level, 'warn')
    })
})

test('the app should log failures from local socket errors', function (t) {
  const app = test_server()
  return st(app)
    .get('/destroy')
    .on('request', (request) => {
      setTimeout(() => request.req.destroy(new Error('socket hang up')), 20)
    })
    .catch((e) => new Promise(resolve => setTimeout(resolve, 1000)))
    .then(() => app.close())
    .then(() => {
      var lines = app.stdout
        .split('\n')
        .filter(Boolean)
        .filter((s) => !s.match(/DeprecationWarning/))
        .map(parse_line)
      t.regex(lines[0].message, /x─  GET \/destroy 599/)
      t.is(lines[0].level, 'error')
    })
})

test('the app should log connections destroyed by client', function (t) {
  const app = test_server()
  return st(app)
    .get('/delay')
    .on('request', (request) => {
      setTimeout(() => request.req.destroy(new Error('socket hang up')), 20)
    })
    .catch((e) => new Promise(resolve => setTimeout(resolve, 1000)))
    .then(() => app.close())
    .then(() => {
      var lines = app.stdout
        .split('\n')
        .filter(Boolean)
        .filter((s) => !s.match(/DeprecationWarning/))
        .map(parse_line)
      t.regex(lines[0].message, /x─  GET \/delay 499/)
      t.is(lines[0].level, 'warn')
    })
})

function test_server (opts) {
  var app = koa()
  app.use(log({}, opts))
  app.use(throw_err)
  app.on('error', () => {})
  var server = app.listen()
  restore = intercept((msg) => {
    server.stdout += msg
    return ''
  })
  server.stdout = ''
  return server
}

function * throw_err (next) {
  if (this.path == '/delay') {
    yield new Promise((resolve) => setTimeout(resolve, 1000))
    this.body = 'ok'
    return
  } else if (this.path == '/destroy') {
    this.res.socket.destroy(new Error('socket hang up'))
  } else if (this.path == '/throw') {
    var err = new Error('this is an error')
    err.prop1 = 'error-prop'
    err.nested = { n: { n: 1 } }
    err.toonested = { n: { n: { n: { n: 1 } } } }
    err.longline = '********************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************************'
    throw err
  }
}

function parse_line (line) {
  var format = /\[(.*?)]\s+(.*)?smplog::(.*)/gm
  var match = format.exec(strip(line))
  return {
    level: match[1],
    message: match[2].trim(),
    meta: JSON.parse(match[3].trim())
  }
}
