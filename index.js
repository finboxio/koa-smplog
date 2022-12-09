var Log = require('smplog')
var assign = require('object-assign')
var Counter = require('passthrough-counter')
var humanize = require('humanize-number')
var bytes = require('bytes')
var chalk = require('chalk')
var { uid } = require('uid')
var flat = require('flat')
var path = require('path')
var parse = require('url').parse
var request_intercept = require('request-intercept')
var request = require('request')
var stringify = require('json-stringify-safe')
var pkg = require('./package.json')

var colorCodes = {
  5: 'red',
  4: 'yellow',
  3: 'cyan',
  2: 'green',
  1: 'green'
}

module.exports = function (defaults, options) {
  defaults = defaults || {}
  options = options || {}

  function out (ctx, start, len, err, event) {
    var status = err
      ? (err.status || 500)
      : (ctx.status || 404)
    var s = status / 100 | 0
    var color = colorCodes[s]
    var length = format_length(len, status)
    var bracket = ctx.log._first ? '─ ' : '┘ '
    var arrow = err ? chalk.red('x' + bracket)
      : event === 'close' ? chalk.yellow('x' + bracket)
      : chalk.gray('<' + bracket)
    var method = chalk.bold(ctx.method)
    var url = ctx.originalUrl.split('?')[0]
    var code = chalk[color](status)
    var duration = chalk.dim(format_time(start))
    var size = chalk.dim(length)
    var ip = ctx.ip.split(':').filter((i) => ~i.indexOf('.')).join('')
    var user_agent = ctx.get('user-agent')
    var referrer = ctx.get('referer') || ctx.get('referrer')

    var level = (options.log_level || log_level)(status)

    var log_info = {
      event: 'request-end',
      method: ctx.method,
      url: url,
      status_code: status,
      response_time_ms: Date.now() - start,
      response_size_bytes: len || 0
    }
    if (referrer) log_info.referrer = referrer
    if (user_agent) log_info.user_agent = user_agent
    if (ip) log_info.ip = ip

    if (err) {
      log_info.error = (options.format_error || format_error)(err)
    }

    ctx.log._nest = false
    ctx.log[level](`${arrow} ${method} ${url} ${code} ${duration} ${size}`, assign(log_info, ctx.log._tags))
    ctx.log._nest = true
  }

  return function * (next) {
    var start = Date.now()
    var ctx = this
    var res = this.res

    if (this.log) {
      var parent = this.log

      // Patch log for subsequent middleware with blackhole logger if request should be filtered
      if (options.filter && !options.filter(ctx)) {
        this.log = Log({}, { log: () => {} })
      } else {
        this.log.tag(defaults)
      }
      yield next

      // Unpatch log
      this.log = parent
    } else {
      // Setup trace id
      this.smplog_trace = this.smplog_trace ||
        this.get('x-smplog-trace') ||
        (Date.now() + uid(8))

      // Initialize log with blackhole logger if request should be filtered
      if (options.filter && !options.filter(ctx)) {
        this.log = Log({}, { log: () => {} })
      } else {
        var logfn = options.log
        var logwrap = ({ timestamp, severity, message, payload }, log) => {
          var fn = logfn || log
          if (this.log._nest) {
            var color = options.color !== false && String(process.env.SMPLOG_COLORS) !== 'false'
            var arrow = this.log._first ? ' ┌  ' : ' ├  '
            arrow = color ? chalk.gray(arrow) : arrow
            message = color ? chalk.gray(message) : message
            fn({ timestamp, severity, message: arrow + message, payload })
          } else {
            fn({ timestamp, severity, message, payload })
          }
          this.log._first = false
        }
        this.log = Log(assign({ smplog_trace: this.smplog_trace }, defaults), assign({}, options, { log: logwrap }))
        this.log._nest = true
        this.log._first = true
      }

      // Attach request client to log
      var client = request_intercept(request)
      client.use(request_interceptor(this.log))
      this.log.request = this.log.agent = client.getMiddlewareEnabledRequest().defaults({
        json: true,
        headers: {
          'x-smplog-trace': this.smplog_trace,
          'user-agent': `smplog client v${pkg.version} - ${stringify(defaults)}`
        }
      })

      // Log request-start event
      var arrow = chalk.gray('>┐ ')
      var method = chalk.bold(this.method)
      var url = this.originalUrl.split('?')[0]
      var ip = this.ip.split(':').filter((i) => ~i.indexOf('.')).join('')
      var user_agent = this.get('user-agent')
      var referrer = this.get('referer') || this.get('referrer')

      var log_info = { event: 'request-start', method: this.method, url }
      if (ip) log_info.ip = ip
      if (user_agent) log_info.user_agent = user_agent
      if (referrer) log_info.referrer = referrer

      if (options.incoming) {
        this.log._nest = false
        this.log.info(`${arrow} ${method} ${url}`, log_info)
        this.log._nest = true
      }

      try {
        yield next
      } catch (err) {
        // Log uncaught downstream errors
        out(this, start, null, err)
        throw err
      }

      // calculate the length of a streaming response
      // by intercepting the stream with a counter.
      // only necessary if a content-length header is currently not set.
      var length = this.response.length
      var body = this.body
      var counter
      if (length == null && body && body.readable) {
        counter = Counter()
        this.body = body
          .pipe(counter)
          .on('error', this.onerror)
      }

      // log when the response is finished or closed,
      // whichever happens first.
      var onfinish = done.bind(null, 'finish')
      var onclose = done.bind(null, 'close')

      res.once('finish', onfinish)
      res.once('close', onclose)
    }

    function done (event) {
      res.removeListener('finish', onfinish)
      res.removeListener('close', onclose)
      out(ctx, start, counter ? counter.length : length, null, event)
    }
  }
}

var log_level = module.exports.log_level = function (status) {
    return status < 400 ? 'info' : (status < 500 ? 'warn' : 'error')
}

var format_time = module.exports.format_time = function (start) {
  var delta = Date.now() - start
  delta = delta < 10000
    ? delta + 'ms'
    : Math.round(delta / 1000) + 's'
  return humanize(delta)
}

var format_length = module.exports.format_length = function (len, status) {
  var length
  if (~[204, 205, 304].indexOf(status)) {
    length = ''
  } else if (len == null) {
    length = '-'
  } else {
    length = bytes(len)
  }
  return length
}

var format_error = module.exports.format_error = function (err) {
  var obj = flat(err, { maxDepth: 1 })
  obj.name = err.name
  obj.message = err.message
  for (var prop in obj) {
    if (Object(obj[prop]) === obj[prop]) {
      delete obj[prop]
    } else if (typeof obj[prop] === 'string' && obj[prop].length > 256) {
      obj[prop] = obj[prop].slice(0, 252) + '...'
    }
  }

  /* istanbul ignore else */
  if (err.stack) {
    var rootdir = __dirname.split(path.sep)
    var base = rootdir.indexOf('node_modules')
    rootdir = rootdir.slice(0, base >= 0 ? base : rootdir.length).join(path.sep)

    obj.stack = err.stack
      .replace(new RegExp(rootdir, 'g'), '.')
      .split('\n')

    let end = 0
    while (obj.stack[end] && !obj.stack[end].match('./node_modules/koa-compose')) {
      end++
    }

    obj.stack = obj.stack.slice(0, end).join('\n')
  }
  return obj
}

// Log outgoing requests
var request_interceptor = module.exports.request_interceptor = (log) => function (options, callback, next) {
  var start = Date.now()
  var trace = options.headers['x-smplog-trace']
  var parsed = parse((options.baseUrl || '') + (options.uri || ''))
  var queryless = `${parsed.protocol}//${parsed.host}${parsed.pathname}`

  var _callback = function (err, response, body) {
    var status = err
      ? (err.status || 500)
      : (response.statusCode || 404)
    var s = status / 100 | 0
    var color = colorCodes[s]
    var len = response && response.headers ? (response.headers['content-length'] || 0) : 0
    var length = format_length(+len, status)
    var method = chalk.bold.yellow.dim(options.method)
    var code = chalk[color].dim(status)
    var duration = chalk.gray(format_time(start))
    var size = chalk.gray(length)
    var level = err ? 'error' : (status < 400 ? 'info' : (status < 500 ? 'warn' : 'error'))

    var msg = `${method} ${chalk.gray(queryless)} ${code} ${duration} ${size}`
    var meta = {
      event: 'nested-request',
      smplog_trace: trace,
      method: options.method,
      url: queryless,
      status_code: status,
      response_time_ms: Date.now() - start,
      response_size_bytes: +len || 0
    }
    log[level](msg, meta)

    callback && callback(err, response, body)
  }

  return next(options, _callback)
}
