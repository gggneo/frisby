'use strict';

// NPM
const _ = require('lodash');
const fetch = require('node-fetch');
const TIMEOUT_DEFAULT = 5000;

// Frisby
const expectHandlers = require('./expects');


class FrisbySpec {
  constructor() {
    this._fetch;
    this._doneFn;
    this._request;
    this._response;
    this._expects = [];
    this._expectError;

    this._timeout = TIMEOUT_DEFAULT;
    this._setupDefaults = {};
    this._lastResult;
  }

  /**
   * Call function to do some setup for this spec/test
   */
  use(fn) {
    fn(this);
    return this;
  }

  /**
   * Setup defaults (probably from globalSetup(), but can be also be called per test)
   */
  setup(opts, replace) {
    this._setupDefaults = replace ? opts : _.merge(this._setupDefaults, opts);
    this._timeout = this._setupDefaults.request.timeout || TIMEOUT_DEFAULT;
    return this;
  }

  /**
   * Timeout getter/setter
   *
   * @param {number} timeout - Max. timeout in milliseconds
   */
  timeout(timeout) {
    // GETTER
    if (!timeout) {
      if (this._setupDefaults.request && this._setupDefaults.request.timeout) {
        return this._setupDefaults.request.timeout;
      }

      return this._timeout;
    }

    // SETTER
    this._timeout = timeout;
    return this;
  }

  /**
   * Load JSON directly for use
   *
   * @param {Object} json - JSON to use as HTTP response
   */
  fromJSON(json) {
    let jsonString = JSON.stringify(json);

    // Prepare headers
    let headers = new fetch.Headers();
    headers.set('Content-Type', 'application/json');

    // Prepare Response object
    this._response = new fetch.Response(jsonString, {
      url: '/',
      status: 200,
      statusText: 'OK',
      headers: headers,
      size: jsonString.length,
      timeout: 0
    });

    // Resolve as promise
    this._fetch = fetch.Promise.resolve(this._response)
      .then(response => response.json())
      .then((responseBody) => {
        this._response._body = responseBody;
        this._runExpects();

        return responseBody;
      }).catch(this._fetchErrorHandler);

    return this;
  }

  /**
   * Fetch given URL with params (passthru to 'fetch' API)
   */
  fetch(url, params) {
    let fetchParams = Object.assign({}, this._setupDefaults.request, params || {});
    this._request = new fetch.Request(url, fetchParams);

    this._fetch = fetch(this._request, { timeout: this.timeout() }) // 'timeout' is a node-fetch option
      .then((response) => {
        this._response = response;

        // Auto-parse JSON
        if (response.headers.has('Content-Type') && ~response.headers.get('Content-Type').indexOf('json')) {
          return response.json();
        }

        return response.text();
      }).then((responseBody) => {
        this._response._body = responseBody;
        this._runExpects();

        return responseBody;
      }).catch(this._fetchErrorHandler.bind(this));

    return this;
  }

  /**
   * GET convenience wrapper
   */
  get(url) {
    return this.fetch(url);
  }

  /**
   * PATCH convenience wrapper
   */
  patch(url, params) {
    return this._requestWithBody('PATCH', url, params);
  }

  /**
   * POST convenience wrapper
   */
  post(url, params) {
    return this._requestWithBody('POST', url, params);
  }

  /**
   * PUT convenience wrapper
   */
  put(url, params) {
    return this._requestWithBody('PUT', url, params);
  }

  /**
   * DELETE convenience wrapper
   */
  del(url) {
    return this.fetch(url, { method: 'delete' });
  }

  /**
   *
   */
  _requestWithBody(method, url, params) {
    let postParams = { method };

    // Auto-encode JSON body
    if (params && _.isObject(params.body)) {
      params.body = JSON.stringify(params.body);
    }

    // Auto-set 'body' from 'params' JSON if 'body' and 'headers' are not provided (assume sending raw body only)
    if (params && _.isUndefined(params.body) && _.isUndefined(params.headers)) {
      postParams.body = JSON.stringify(params);
    }

    return this.fetch(url, Object.assign(postParams, params || {}));
  }

  /**
   * Chain calls to execute after fetch()
   */
  then(fn) {
    if (fn instanceof FrisbySpec) {
      return fn
    }

    this._ensureHasFetched();
    this._fetch.then((responseBody) => {
      let result;

      if (this._lastResult && (this._lastResult instanceof FrisbySpec || this._lastResult instanceof Promise)) {
        result = this._lastResult.then(fn);

        // Move 'done' to new promise and remove it from this one
        let doneFn = this._doneFn;
        if (doneFn) {
          this._lastResult.then(() => doneFn());
          this._doneFn = null;
        }
      } else {
        result = fn(responseBody);
        this._lastResult = result;
      }

      if (result) {
        return result;
      } else {
        return responseBody;
      }
    }).catch(this._fetchErrorHandler.bind(this));

    return this;
  }

  /**
   * Used for 'done' function in Jasmine async tests
   * Ensures any errors get pass
   */
  done(doneFn) {
    this._doneFn = doneFn;
    this._fetch.then(() => this._doneFn ? doneFn() : null);
    return this;
  }

  /**
   * Custom error handler (Promise catch)
   */
  catch(fn) {
    this._expectError = fn;
    return this;
  }

  /**
   * Return internal promise used by Frisby.js
   * Note: Using this will break the chainability of Frisby.js method calls
   */
  promise() {
    return this._fetch;
  }

  _fetchErrorHandler(err) {
    // User can handle expected errors manually if desired
    if (this._expectError) {
      return this._expectError(err);
    }

    if (typeof fail === 'function') {
      // If a 'fail' method is provided, use it (Jasmine 2.1+)
      fail(err);
    } else if (typeof expect === 'function') {
      // Hack alert: This is the easiest way I found to fail an async Jasmine
      // test (ex. in a Promise chain) and still show the full error and stack
      // trace to the user when 'fail' is not provided
      expect(err.stack).toBeNull();
    } else {
      throw err;
    }
  }

  /**
   * Run test expectations
   */
  _runExpects() {
    this._ensureHasFetched();

    // Run all expectations
    this.then(() => {
      for(let i = 0; i < this._expects.length; i++) {
        this._expects[i].call(this, this._response);
      }
    });

    return this;
  }

  /**
   * Inspectors (to inspect data that the test is returning)
   * ==========================================================================
   */

  inspectResponse() {
    return this.then(() => { this.inspectLog("\nResponse:", this._response); });
  }

  inspectRequest() {
    return this.then(() => { this.inspectLog("\nRequest:", this._request); });
  }

  inspectBody() {
    return this.then(() => { this.inspectLog("\nBody:", this._response._body); });
  }

  inspectJSON() {
    return this.then(() => { this.inspectLog("\nJSON:", JSON.stringify(this._response._body, null, 4)); });
  }

  inspectStatus() {
    return this.then(() => { this.inspectLog("\nStatus:", this._response.status); });
  }

  inspectHeaders() {
    return this.then(() => {
      this.inspectLog("\n");
      this.inspectLog('Headers:');
      let headers = this._response.headers._headers;
      for (let key in headers) {
        this.inspectLog("\t" + key + ': ' + headers[key]);
      }
    });
  }

  inspectLog() {
    let params = Array.prototype.slice.call(arguments);
    console.log.apply(null, params);
    return this;
  }

  /**
   * Expectations (wrappers around Jasmine methods)
   * ==========================================================================
   */

  /**
   * Add expectation for current test (expects)
   */
  expect(expectName) {
    let expectArgs = Array.prototype.slice.call(arguments).slice(1);
    return this._getExpectRunner(expectName, expectArgs, true);
  }

  /**
   * Add negative expectation for current test (expects.not)
   */
  expectNot(expectName) {
    let expectArgs = Array.prototype.slice.call(arguments).slice(1);
    return this._getExpectRunner(expectName, expectArgs, false);
  }

  /**
   * Private methods (not meant to be part of the public API, and NOT to be
   * relied upon by consuming code - these names may change!)
   * ==========================================================================
   */

  /**
   * Used internally for expect and expectNot to add expectations and then run them
   */
  _getExpectRunner(expectName, expectArgs, expectPass) {
    let expectHandler;

    if (_.isFunction(expectName)) {
      expectHandler = expectName;
    } else {
      expectHandler = expectHandlers[expectName];
      if (typeof expectHandler === 'undefined') {
        throw new Error("Expectation '" + expectName + "' is not defined.");
      }
    }

    return this._addExpect((response) => {
      try {
        expectHandler.apply(this, [response].concat(expectArgs));
      } catch(e) {
        // Re-throw error if pass is expected; else bury it
        if (expectPass === true) {
          this._fetchErrorHandler(e);
        }
      }
    });
  }

  /**
   * Ensure fetch() has been called already
   */
  _ensureHasFetched() {
    if (typeof this._fetch === 'undefined') {
      throw new Error('Frisby spec not started. You must call fetch() first to begin a Frisby test.');
    }
  }

  /**
   * Add expectation to execute after HTTP call is done
   */
  _addExpect(fn) {
    this._expects.push(fn);
    return this;
  }

  /**
   * Static methods (mainly ones that affect all Frisby tests)
   * ==========================================================================
   */
  static addExpectHandler(expectName, expectFn) {
    expectHandlers[expectName] = expectFn;
  }
  static removeExpectHandler(expectName) {
    delete expectHandlers[expectName];
  }
}

module.exports = FrisbySpec;
