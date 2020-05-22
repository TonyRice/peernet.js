const { expose } = require("threads/worker");
const {encrypt, decrypt} = require('../util/crypto');

const Crypto = {
    encrypt,
    decrypt
}

expose(Crypto)
