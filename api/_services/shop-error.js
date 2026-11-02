/* A refusal the service decided on: bad input, not found, out of stock. It goes
   back to the browser with its own status and a code the screen turns into a
   sentence. Anything else that is thrown is a fault, and stays opaque. */
'use strict';

class ShopError extends Error {
  /** @param {number} status  @param {string} code  @param {object} [extra] */
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

module.exports = { ShopError };
