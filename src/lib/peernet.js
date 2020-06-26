import IPFS from "ipfs";
import Hash from 'ipfs-only-hash';
import sha1 from 'crypto-js/sha1.js';
import Base64 from 'crypto-js/enc-base64.js';
import ipfsClient from 'ipfs-http-client';
import {generateKeyPair, sign, encrypt, decrypt, verify} from './util/crypto.js';
import {sleep, uuidv4, randomData} from './util/index.js';
import {add, cat, pin, unpin, connect, disconnect, DEFAULT_BOOTSTRAP, DEFAULT_BOOTSTRAP_BROWSER} from './util/ipfs.js';
import logger from './util/logger.js';

const PEERNET_BOOTSTRAP = [
  "/dns4/arthur.bootstrap.peernet.dev/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
  "/dns4/john.bootstrap.peernet.dev/tcp/4001/p2p/QmcSJKAznvnnVKyWbRhzJDTqLnp1LuNXS8ch9SwcR713bX",
];

const PEERNET_BOOTSTRAP_BROWSER = [
  "/dns4/arthur.bootstrap.peernet.dev/tcp/4002/wss/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
  "/dns4/john.bootstrap.peernet.dev/tcp/4002/wss/p2p/QmcSJKAznvnnVKyWbRhzJDTqLnp1LuNXS8ch9SwcR713bX"
];

class Peer {

  constructor(config) {
    this._started = false;

    config = config ? config : {
      relays: []
    };

    this._relayedPeers = new Map();

    this._subscriptions = new Map();

    this._replyHosts = new Map();
    this._msgCache = new Map();

    this._replyCallbacks = new Map();
    this._peerPubKeyCache = new Map();

    this._bootstraps = config.bootstrap ? config.bootstrap : [];

    if ((typeof window) === 'object') {
      this._bootstraps = this._bootstraps.concat(PEERNET_BOOTSTRAP_BROWSER);
    } else {
      this._bootstraps = this._bootstraps.concat(PEERNET_BOOTSTRAP);
    }

    this._proxyMode = config.proxy ? config.proxy === true : false;
    this._proxyHost = config.proxyHost ? config.proxyHost : 'http://localhost:5001';
    this._publicKey = config.publicKey ? config.publicKey : null;
    this._privateKey = config.privateKey ? config.privateKey : null;
    this._privateKeyPass = config.privateKeyPass ? config.privateKeyPass : null;

    // this will tell the server to act as a passthrough relay for it's own messages
    this._passthrough = config.passthrough ? config.passthrough === true : false;

    // these are hosts we wish to handle data for in a passthrough manner.
    this._passthroughPeers = config.passthroughPeers ? config.passthroughPeers : [];

    // this tells the node that it is able to relay messages directly
    this._relayMessages = config.relay ? config.relay === true && this._passthrough === false : false;
    // trusted hosts are hosts that we allow messages to be relayed
    // to if we are in relay mode.
    this._trustedPeers = config.relayPeers ? config.relayPeers : [];

    // this tells the node that it will receive and process messages directly.
    this._handleMessages = config.receive ? config.receive === true && this._passthrough === false : false;

    // If a peer is considered a single peer, it won't check for acks
    this._checkPubAcks = config.standalone ? config.standalone !== true : true;

    this._ackExists = (typeof config.ackExists) === 'function' ? config.ackExists : null;
    this._storeAck = (typeof config.storeAck) === 'function' ? config.storeAck : null;

    // Let's set a default list of relay peers. This is an
    // open relay.
    this._relays = config.relays ? config.relays : [
      'QmQbPMhrbYbBLvuCaUDVhuBFG2m9ddPUroq5XPyHQdh8gN'
    ];

    this._fetchMessages = config.retrieveMessages ? config.retrieveMessages : false;

    this._config = config ? config : {};

    this._bootstrapTimer = -1;

    this._unlockTimer = -1;

    this.localLocks = new Map();
    this.localUnlocks = new Map();

  }

  // Note: private methods are declared as variables for
  // NodeJS 12.x.x support
  _checkInitialized() {
    if (this.ipfs !== null && this._started === true) {
      return;
    }

    throw "Not initialized!";
  };

  async _doPeerCheck() {
    // let's check for any dead peers
    const peers = await this.ipfs.swarm.peers();

    const findBootStrapAddr = (peer) => {
      for (const bootstrap of this._bootstraps) {
        if (bootstrap.indexOf(peer.peer) > -1) {
          return bootstrap;
        }
      }
      return null;
    };

    for (const peer of peers) {

      let pass = false;

      const addr = findBootStrapAddr(peer);

      if (addr == null) {
        continue;
      }
      try {

        for await (const ping of (this.ipfs.ping(peer.peer, {
          'timeout': '30s',
          'count' : 3
        }))) {
          pass = ping.success;
        }
        if (pass) {
          continue;
        }
        logger.debug('Ping Failed: ' + JSON.stringify(peer))
      } catch (err) {
      }

      try {

        logger.debug('Disconnecting from ' + addr);

        try {

          await disconnect(this.ipfs, addr);
          await sleep(150);
        } catch (ignored) {
        } finally {
          logger.info('Connecting to ' + addr);
          await connect(this.ipfs, addr);
        }
      } catch (err) {
        logger.error('Peer Reconnect Failed: ' + err.toString())
      }
    }
  }

  async _reconnectBootstraps() {
    const _peerId = await this.ipfs.id();
    const peers = await this.ipfs.swarm.peers();
    const peerAddrs = peers.map((peer) => {
      return peer.addr.toString();
    });
    const peerIds = peers.map((peer) => {
      return peer.id;
    });
    for (const addr of this._bootstraps) {
      const idx = peerAddrs.indexOf(addr);

      const peerId = peerIds[idx];

      if (_peerId === peerId) {
        continue;
      }

      if (idx === -1) {
        try {
          await connect(this.ipfs, addr);
        } catch (err) {
        }
      }
    }
  };

  async _waitForAck(ackData, timeout) {
    timeout = timeout ? timeout : '30s';

    try {

      const ackHash = await Hash.of(Buffer.from(ackData));

      logger.debug('Waiting for ack: ' + ackHash);

      // let's relay this until we got the ack.
      const detectedAckData = await cat(this.ipfs, ackHash, timeout);

      if (detectedAckData === ackData) {
        logger.debug('Ack detected!! ' + ackHash);
      }

      return detectedAckData;

    } catch (err) {
      logger.error('waitForAck: ' + err);
    }
    return null;
  };

  async _handleAck(ackData) {
    const ackCid = await add(this.ipfs, ackData, '240s');

    try {
      await pin(this.ipfs, ackCid);
    } catch (ignored) {
    } finally {
      setTimeout(async () => {
        try {
          await unpin(this.ipfs, ackCid, true);
        } catch (ignored){}
      }, 60000 * 5);
    }

    // run our custom function
    // to store the ack
    if (this._storeAck !== null) {
      try {
        this._storeAck(ackCid);
      } catch (err) {
        logger.error('Failed to store ack: ' + err.toString());
      }
    }

    logger.debug('Acknowledgement added: ' + ackCid);

    return ackCid;
  };

  async _storeMessage(payload) {
    const msgHash = '/msgs/' + payload.topic + '/' + (payload.id ? payload.id : uuidv4());

    await this.ipfs.files.write(msgHash, payload.data, {
      create: true,
      parents: true
    });

    setTimeout(async() => {
      try {
        logger.debug('Deleting message from temporary storage: ' + msgHash);
        await this.ipfs.files.rm(msgHash);
      } catch (e) {
        logger.error('Failed to delete message from temporary storage: ' + msgHash + ' ' + e.toString())
      }
    }, 60000 * 5);

    return msgHash;

  }

  async _retrieveMessages (peer, count) {
    const peerData = await this._getPeerData(peer);

    const path = '/msgs/' + peerData.address + '/';

    const msgs = [];

    try {
      for await (const file of this.ipfs.files.ls(path)) {
        if (msgs.length >= count) {
          break;
        }
        const cid = file.cid.toString();
        msgs.push(cid);

        try {
          await this.ipfs.files.rm(path + file.name);
        } catch (e) {
        }
      }
    } catch(ignored){
    }

    return msgs;
  }

  async _getPeerData(peer) {
    this._checkInitialized();

    const ipfs = this.ipfs;

    // todo this needs to be optimized

    // todo attempt to validate.
    if (this._peerPubKeyCache.has(peer)) {
      return Promise.resolve(this._peerPubKeyCache.get(peer));
    }

    let peerPubKey;

    if (peer.trim().indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----') === 0) {
      peerPubKey = peer;
    } else {
      try {
        const stream = await cat(ipfs, peer, '60s');
        if (stream == null) {
          return Promise.reject("Could not find peer data using the CID \"" + peer + "\".");
        }

        if (stream.indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----') === 0) {
          peerPubKey = stream;

          await pin(ipfs, peer);
        } else {
          try {
            const jsonData = JSON.parse(stream);
            if (jsonData.hasOwnProperty('publicKey')) {
              peerPubKey = jsonData['publicKey'];
            }
          } catch (ignored) {
            return Promise.reject('Invalid peer data detected!');
          }
        }
      } catch (err) {
        return Promise.reject(err);
      }
    }

    const address = sha1(peerPubKey.replace('\r\n', '').replace('\n').trim() + '.address');

    const peerCid = await add(this.ipfs, peerPubKey);

    const data = {
      'publicKey': peerPubKey,
      'address': Base64.stringify(address),
      'cid': peerCid
    };

    this._peerPubKeyCache.set(peer, data);

    return Promise.resolve(data);
  }

  async _broadcast(peer, type, payload, config, callback) {
    config = ((typeof config) === 'object') ? config : {};
    let waitForReply = false;
    let relayMessage = false;
    let storeMessage = false;

    let timeoutError = true;

    callback = ((typeof callback) === 'function') ? callback : ((typeof config) === 'function') ? config : null;
    let timeout = ((typeof config['timeout']) === 'string') ? config['timeout'] : '180s';

    if (config.hasOwnProperty('waitForReply')) {
      waitForReply = config['waitForReply'];
    }
    if (config.hasOwnProperty('callback')) {
      callback = config['callback']
    }
    if (config.hasOwnProperty('timeout')) {
      timeout = config['timeout'];
    }
    if (config.hasOwnProperty('relayMessage')) {
      relayMessage = config['relayMessage'];
    }
    if (config.hasOwnProperty('storeMessage')) {
      storeMessage = config['storeMessage'];
    }

    if (config.hasOwnProperty('timeoutError')) {
      timeoutError = config['timeoutError'];
    }
    return new Promise(async (finished, failed) => {
      try {
        this._checkInitialized();

        // retrieve the peer data for the
        // peer we wish to send a message to.
        const node = this.ipfs,
          peerData = await this._getPeerData(peer);

        // generate message acknowledgement data
        const msgAck = config.hasOwnProperty('msgAck') ? config['msgAck'] :
          config.hasOwnProperty['relayAckFunc'] && (typeof config['relayAckFunc']) === 'function' ? config['relayAckFunc']() : randomData();;
        // generate message acknowledgement data for
        // each relay.
        const relayAcks = this._relays.map(() => {
          return config.hasOwnProperty('relayAck') ? config['relayAck'] :
            config.hasOwnProperty['relayAckFunc'] && (typeof config['relayAckFunc']) === 'function' ? config['relayAckFunc']() : randomData();
        });

        const storeAck = randomData();

        const original = callback;

        let replyId = null;

        if (waitForReply === true && storeMessage === false) {
          replyId = uuidv4();
          // generate a reply id and store the peer
          // and the function we want to trigger
          // as a callback.
          callback = (msg) => {
            if ((typeof original) === 'function') {
              original(msg);
            }

            // Let's go ahead and speed up
            // the ack
            add(this.ipfs, msgAck).then(async () => {
              for (const replyAck of relayAcks) {
                await add(this.ipfs, msgAck);
              }
            });
          };

          this._replyCallbacks.set(replyId, callback);
          this._replyHosts.set(replyId, peerData.publicKey);
        }

        const _payload = {
          "type": type,
          "replyId": replyId,
          "relayAck": relayAcks // this is where the peer needs to send an ack back
        };

        Object.keys(payload).forEach((key) => {
          _payload[key] = payload[key];
        });

        const jsonData = {
          "payload": _payload,
          "ack": {
            "data": msgAck
          },
          "key": this._publicKey
        };

        // encrypt the data
        const encryptedPayload = await encrypt(peerData.publicKey, JSON.stringify(jsonData));

        const peerAddress = peerData.address;

        // publish the data immediately
        await this._publish(peerAddress, encryptedPayload);

        const repeat = setInterval(async () => {
          await this._publish(peerAddress, encryptedPayload);
        }, 2500);

        const timeouts = [];

        try {

          // Let's make sure the data is relayed
          if (relayMessage === true || storeMessage === true) {

            // Publish the message to the relay peers
            for (const relayPeer of this._relays) {
              const idx = this._relays.indexOf(relayPeer);
              const relayAckData = relayAcks[idx];
              const relayPeerData = await this._getPeerData(relayPeer);
              const relayPubKey = relayPeerData.publicKey;

              const relayMsg = JSON.stringify({
                'payload': {
                  'type': 'relay',
                  'data': encryptedPayload,
                  'peer': peerData.publicKey,
                  "reply": replyId != null, // tell the relay to attempt to relay replies
                  "id" : uuidv4(),
                  "store" : storeMessage === true, // Should the relay store this message to be retrieved?
                  "storeAck" : storeMessage === true ? { data : storeAck} : null // if we want to store the message, we need a store ack
                },
                'key': this._publicKey,
                'ack': {
                  'data': relayAckData
                }
              });

              const encryptedRelay = await encrypt(relayPubKey, relayMsg);

              logger.debug('Relaying message to peer ' + relayPeerData.address);

              await this._publish(relayPeerData.address, encryptedRelay);

              const relayTimeout = setInterval(async () => {
                await this._publish(relayPeerData.address, encryptedRelay);
              }, 5000);

              timeouts.push(relayTimeout);
            }
          }

          timeouts.push(setTimeout(async () => {
            await this._doPeerCheck();
          }, 15000))

          // If we're storing it, we only want to wait for it to be stored
          const ackData = await this._waitForAck((storeMessage === true ? storeAck : msgAck), timeout);

          // Does the ack data match?
          if (ackData === (storeMessage === true ? storeAck : msgAck)) {
            finished();
          } else {
            if (ackData == null || (typeof ackData) === 'undefined') {
              if (timeoutError) {
                failed('Timeout reached while waiting for a reply or acknowledgement.');
              } else {
                finished();
              }
            }
          }
        } catch (err) {
          if (timeoutError) {
            failed('Timeout reached while waiting for a reply or acknowledgement.');
          } else {
            finished();
          }
        } finally {
          clearTimeout(repeat);

          for (const t of timeouts) {
            clearTimeout(t);
          }
        }
      } catch (err) {
        failed(err);
      }
    });
  }

  async _receive(data) {
    const buff = Buffer.from(data, 'base64');
    return buff.toString('ascii');
  }

  async _encode(Data) {
    const buff = Buffer.from(data);
    return buff.toString('base64');
  }

  async _publish(message, data) {
    const buff = Buffer.from(data);
    return await this.ipfs.pubsub.publish(message, buff.toString('base64'));
  }

  started() {
    return this._started;
  }

  async start() {
    if (this.ipfs != null && this._started) {
      return Promise.resolve({
        publicKey: this._publicKey,
        privateKey: this._privateKey
      });
    }

    return new Promise(async (accept, reject) => {
      logger.info('Initializing...');

      try {

        if (this._privateKey != null) {
          this._privateKeyArmored = this._privateKey;
        } else {

          logger.debug('Generating private/public keys...');

          this._privateKeyPass = this._privateKeyPass != null ? this._privateKeyPass : uuidv4();

          // A client key is generated on each use. It is only used by the browser during the instance
          // session.
          const {privateKeyArmored, publicKeyArmored} = await generateKeyPair(uuidv4(), 'web-client@peernet.dev', this._privateKeyPass)

          this._privateKeyArmored = privateKeyArmored;
          this._publicKey = publicKeyArmored;
        }

        logger.debug('Initializing IPFS...');

        let node;

        if (this._proxyMode === true) {
          node = ipfsClient(this._proxyHost);
          await node.id()
          this.ipfs = node;
        } else {
          let options;

          // The browser uses a different set of bootstrap nodes.
          if ((typeof window) === 'undefined') {
            options = {
              repo: this._config.repo ? this._config.repo : undefined,
              config: {
                // If you want to connect to the public bootstrap nodes, remove the next line
                Bootstrap: this._bootstraps.concat(DEFAULT_BOOTSTRAP)
              }
            }
          } else {
            options = {
              repo: 'ipfs-' + Math.random(),
              config: {
                Addresses: {
                  Swarm: []
                },
                // If you want to connect to the public bootstrap nodes, remove the next line
                Bootstrap: this._bootstraps.concat(
                  DEFAULT_BOOTSTRAP_BROWSER
                )
              }
            }
          }

          logger.debug('Starting IPFS...');

          node = await IPFS.create(options);
          await node.id();
          this.ipfs = node;
        }

        logger.debug('Waiting for IPFS peers...');

        let waiting = true;

        setTimeout(() => {
          waiting = false
        }, 5000);

        // let's just add some startup time
        // to give some time to check for some peers
        while (waiting) {
          let peers = await node.swarm.peers();
          if (peers.length > 1) {
            waiting = false;
          } else {
            await sleep(150);
          }
        }

        // Note: let's add our peer data to IPFS
        const peerCid = await add(node, this._publicKey);

        logger.debug('Pinning peer CID: ' + peerCid);

        await pin(node, peerCid);

        logger.debug('Adding direct relay peers...');

        // these are hosts that we are relaying data for.
        // we need to add these to the this._relayedPeers map
        // to tell the peer to allow these messages to be relayed
        for (const peer of this._trustedPeers) {
          const peerData = await this._getPeerData(peer);

          // for non passthrough mode
          // this must be false
          this._relayedPeers.set(peerData.address, false);
        }

        logger.debug('Configuring pass-through relay peers...');

        for (const peer of this._passthroughPeers) {
          await this.relayPeer(peer, true);
        }

        // This will attempt to keep things connected.
        this._bootstrapTimer = setInterval(async () => {
          await this._reconnectBootstraps();
        }, 15000 * 3);

        this._pingTimer = setInterval(async () => {

          await this._doPeerCheck();

        }, 60000 * 1.5);

        // this is experimental functionality - this will go
        // ahead and attempt to retrieve any messages from any peers
        this._retrieveTimer = setInterval(async () => {
          if (this._fetchMessages === false) {
            return;
          }

          const peer = await this._getPeerData(this._publicKey);

          // if this peer isn't subscribed to messages then we don't need
          // to check for any from any relays
          if (!this._relayedPeers.has(peer.address) && !this._handleMessages || ((typeof window) !== 'undefined')) {
            return;
          }

          for (const relayPeer of this._relays) {
            const relayAckData = randomData();
            const relayPeerData = await this._getPeerData(relayPeer);
            const relayPubKey = relayPeerData.publicKey;

            // todo change to broadcast
            const retrieveMsg = {
              "payload": {
                'type': 'retrieve',
                'count': await sign(this._privateKeyArmored, this._privateKeyPass, "15")
              },
              "ack": {
                "data": relayAckData
              },
              "key": this._publicKey
            };

            const encrypted = await encrypt(relayPubKey, JSON.stringify(retrieveMsg));

            await this._publish(relayPeerData.address, encrypted);

            const relayTimeout = setInterval(async () => {
              await this._publish(relayPeerData.address, encrypted);
            }, 1500);

            try {

              const ackHash = await Hash.of(Buffer.from(relayAckData));

              const ackData = await cat(node, ackHash, '15s');

              if (ackData !== relayAckData) {
                logger.debug('Failed to retrieve messages from the relay: ' + relayPeerData.cid);
              }
            } catch (err) {

            } finally {
              clearTimeout(relayTimeout);
            }
          }

        }, 30000);

        this._unlockTimer = setInterval(async () => {
          // If a local lock has been unlocked,
          // then we can remove the local record
          for (const addr of this.localLocks.keys()) {
            const lockAckData = this.localLocks.get(addr);

            // This data shouldn't take long to retrieve.
            const lockAck = cat(node, await hash(lockAckData), '3s');

            if (lockAck !== null) {
              this.localLocks.delete(addr);
            }
          }
        }, 60000 * 3);

        this._started = true;

        logger.info('Started! Your peer CID is: ' + peerCid);

        accept({
          publicKey: this._publicKey,
          privateKey: this._privateKeyArmored
        });
      } catch (err) {
        reject(err);
      }
    })
  }

  async stop() {
    if (this.ipfs == null) {
      return Promise.reject('Peer not started!');
    }

    try {
      for (const entry of this._subscriptions.entries()) {
        await this.ipfs.pubsub.unsubscribe(entry[0], entry[1]);
      }
      if (this._proxyMode === false) {
        await this.ipfs.stop();
      }

      clearTimeout(this._unlockTimer);
      clearTimeout(this._retrieveTimer);
      clearTimeout(this._bootstrapTimer);
      clearTimeout(this._pingTimer);
    } finally {
      this._unlockTimer = -1;
      this._retrieveTimer = -1;
      this._bootstrapTimer = -1;
      this._pingTimer = -1;

      this.ipfs = null;
      this._started = false;
    }
  }

  init() {
    return this.start();
  }

  relayPeer(peer, passthrough, until) {
    passthrough = passthrough ? passthrough === true : false;
    until = until ? until : 0;

    // this will go ahead and subscribe for data
    // destined for a specific peer and publicly relay
    // it's data.
    return new Promise(async (accept, reject) => {
      if ((typeof window) === 'object') {
        reject('Relay support is not supported in the browser.');
        return;
      }

      const peerData = await this._getPeerData(peer);

      let originalValue = null;

      if (this._relayedPeers.has(peerData.address)) {
        const value = this._relayedPeers.get(peerData.address);

        // only check if a pass-through already
        // exists for this peer only if we are
        // setting it to do so.
        if (value && passthrough === true) {
          reject('This peer is already being relayed in pass-through mode.');
          return;
        }
        originalValue = value;
      }

      if (passthrough === false) {
        // if the original value isn't false
        this._relayedPeers.set(peerData.address, originalValue != null ? originalValue : false);

        // any peers we pass here directly must be added to the relay peer trust
        this._trustedPeers.push(peerData.cid);
        accept();
      } else {

        logger.debug('Relaying peer in pass-through mode with the public key: ' + peerData.publicKey);

        // we're passing an empty handler
        // just to sink data into and let
        // ipfs pass it off.
        const handler = () => {
        };

        await this.ipfs.pubsub.subscribe(peerData.address, handler);

        this._subscriptions.set(peerData.address, handler);
        this._relayedPeers.set(peerData.address, true);

        if (until > 0) {
          setTimeout(async () => {
            try {
              await this.ipfs.pubsub.unsubscribe(peerData.address, handler)
            } catch (err) {
            } finally {
              this._subscriptions.delete(peerData.address);

              // if the original value was anything other
              // than null, that means this peer is a trusted
              // relay peer. we just don't want to pass-through
              // relay anymore
              if (originalValue !== null) {
                this._relayedPeers.set(peerData.address, false);
              } else {
                this._relayedPeers.delete(peerData.address);
              }
            }
          }, until);
        }

        accept();
      }
    });
  }

  /**
   * Tells the peer to act in pass-through mode only. This means messages
   * will not be processed, but rather relayed through ipfs.
   *
   * @param passthrough
   * @returns {Peer} returns this peer for method chaining
   */
  passthrough(passthrough) {
    this._passthrough = passthrough === true;
    this._handleMessages = passthrough === true ? false : this._handleMessages;
    this._relayMessages = passthrough === true ? false : this._relayMessages;

    return this;
  }

  /**
   * If true the peer will process messages that it has received. Setting
   * this to true will disable pass-through mode on the peer.
   *
   * @param receiveMessages
   * @returns {Peer} returns this for method chaining
   */
  receive(receiveMessages) {
    this._passthrough = receiveMessages === true ? false : this._passthrough;

    this._handleMessages = receiveMessages ? receiveMessages : true;
    return this;
  }

  /**
   * When this is true, this will tell the peer that it is allowed
   * to directly relay messages.
   *
   * @param relayMessages
   * @returns {Peer} returns this for method chaining
   */
  relay(relayMessages) {
    this._passthrough = relayMessages === true ? false : this._passthrough;

    this._relayMessages = relayMessages ? relayMessages : false;
    return this;
  }


  /**
   * This will go ahead and tell the peer to subscribe to messages. The peer
   * will not receive any messages until this is called.
   *
   * @param handler to process messages
   *
   * @returns {Promise<>}
   */
  sub(handler) {
    return new Promise(async (accept, reject) => {
      try {

        this._checkInitialized();

        const peer = await this._getPeerData(this._publicKey);

        const node = this.ipfs;

        if (this._relayedPeers.has(peer.address)) {
          reject('This peer is already receiving events.');
          return;
        }

        const hitTimers = {};
        const msgHits = {};

        const checkHits = async (from) => {
          msgHits[from] = msgHits.hasOwnProperty(from) ? msgHits[from] + 1 : 1;

          const hits = msgHits[from];
          if (hits === 1) {
            // in 15s we will clear it
            hitTimers[from] = setTimeout(() => {
              delete hitTimers[from];
              delete msgHits[from];
            }, 15000);

          } else {
            // If we have more than 50 messages within 15 seconds
            // it's pretty safe to assume they're sending too many
            // messages

            // TODO make this configurable
              if (hits > 250) {
                throw "Too many messages received!";
              }
          }
        };

        const receiveMsg = async (msg) => {
          try {
            if (this._passthrough === true) {
              return;
            }

            const msgData = msg.data.toString();

            if (this._msgCache.has(msgData)) {
              return;
            }

            const decrypted = await decrypt(this._privateKeyArmored, this._privateKeyPass, await this._receive(msgData));

            const _data = JSON.parse(decrypted);
            const {ack, payload, key} = _data;

            const {type} = payload;

            // let's go ahead and craft a reply.
            const peerData = await this._getPeerData(key);

            logger.debug('Processing message with the type \'' + type + '\' from the peer ' + peerData.cid);

            this._msgCache.set(msgData, true);

            setTimeout(() => {
              try {
                this._msgCache.delete(msg);
              } catch (ignored) {
              }
            }, 60000 * 5);

            if (type === 'msg') {
              // handle direct messages!
              if (this._handleMessages !== true) {
                return;
              }

              await checkHits(msg.from);

              const {data: msgAck} = ack;

              const ackHash = await Hash.of(Buffer.from(msgAck));

              // This simply checks if a message has already been
              // processed
              if (this._checkPubAcks === true && false) {
                logger.debug('Checking if message acknowledgement exists \'' + ackHash + '\'...');

                // let's run our custom function
                // to determine if the ack exists
                if (this._ackExists !== null) {
                  const exists = await this._ackExists();

                  if (exists) {
                    return true;
                  }
                } else {
                  // this should be optimized
                  const detectedAck = await cat(node, ackHash, '5s');

                  // this should return null
                  if (detectedAck != null) {
                    logger.debug('Message acknowledgement exists \'' + ackHash + '\'...');
                    return null;
                  }
                }
              }

              try {
                let replyResult = null;
                if ((typeof handler) === 'function') {
                  logger.debug('Processing pub message on the address \'' + payload.address + '\',,,');
                  try {
                    const result = await handler(payload.address, payload.message);
                    if (result != null) {
                      replyResult = result;
                    }
                  } catch (e) {
                    logger.error('Failed to process pub message on the address \'' + payload.address + '\'! ' + e.toString());
                  }
                }

                // the client is expecting a reply...
                if (payload.hasOwnProperty('replyId') && payload['replyId'] != null) {

                  logger.debug('Sending reply to the peer \'' + peerData.cid + '\'...');

                  const signedMsg = await sign(this._privateKeyArmored, this._privateKeyPass,
                    replyResult != null ? replyResult.toString() : '');

                  // can we possible return a list of peers to bootstrap from?

                  const replyAckData = randomData();

                  // sign the payload
                  const replyLoad = {
                    "payload": {
                      'type': 'reply',
                      'message': signedMsg,
                      'replyId': payload['replyId']
                    },
                    "key": this._publicKey,
                    "ack": {
                      data: replyAckData
                    }
                  };

                  const replyEnc = await encrypt(peerData.publicKey, JSON.stringify(replyLoad));

                  // TODO should we send this reply until we get an ack?

                  const repeat = setInterval(async () => {
                    await this._publish(peerData.address, replyEnc);
                  }, 2500);

                  await this._publish(peerData.address, replyEnc);

                  try {
                    await this._waitForAck(replyAckData);
                  } catch (err) {
                    logger.error('Reply Ack Error: ' + err.toString());
                  } finally {
                    clearTimeout(repeat);
                  }
                }
              } catch (err) {
                logger.error('Failed to process message: ' + err.toString());
              }

              // Acknowledge the request!
              await this._handleAck(msgAck);

              if (payload.hasOwnProperty('relayAck')) {
                const relayAcks = payload.relayAck;
                for (const relayAck of relayAcks) {
                  await this._handleAck(relayAck);
                }
              }

            } else if (type === 'lock') {

              if (key === this._publicKey && payload.hasOwnProperty('address')) {

                const {address: signedAddr} = payload

                const addr = await verify(this._publicKey, signedAddr);

                if (addr !== null) {

                  const {data: lockAck} = ack;

                  const ackHash = await Hash.of(Buffer.from(lockAck));

                  const detectedLockAck = await cat(node, ackHash, '5s');

                  if (detectedLockAck != null) {

                    logger.debug('Message acknowledgement exists \'' + ackHash + '\'...');

                    // We will lock this since the ack don't exist
                    this.localLocks.delete(addr);

                    return null;
                  }

                  // We will lock this since the ack don't exist
                  this.localLocks.set(addr, lockAck);
                }
              }
            } else if (type === 'unlock') {
              if (key === this._publicKey && payload.hasOwnProperty('address')) {
                const {address: signedAddr} = payload
                const addr = await verify(this._publicKey, signedAddr);
                if (addr !== null) {
                  const {data: unlockAck} = ack;
                  if (this.localLocks.has(addr)) {
                    this.localUnlocks.set(addr, unlockAck);
                    const lockAck = this.localLocks.get(addr);
                    await this._handleAck(lockAck);
                  }
                }
              }
            } else if (type === 'pin') {
              // Add support for pinning data on trusted peers
              if (this._trustedPeers.indexOf(peerData.cid) >-1 || this._trustedPeers.indexOf(peerData.publicKey) > -1) {

                // we need to verify this message
                const cid = await verify(peerData.publicKey, payload['cid']);

                if (cid != null) {

                  logger.info('Attempting to pin \"' + cid + '\"..');

                  try {
                    await pin(this.ipfs, cid, '120m');
                    logger.info('Pinned the cid \"' + cid + '\"..');
                  } catch (e) {
                    logger.error('Failed to pin \"' + cid + '\"! ' + e);
                  }

                  const {data: msgAck} = ack;

                  await this._handleAck(msgAck);
                }
              }
            } else if (type === 'unpin') {
              // Add support for pinning data on trusted peers
              if (this._trustedPeers.indexOf(peerData.cid) >-1 || this._trustedPeers.indexOf(peerData.publicKey) > -1) {

                // we need to verify this message
                const cid = await verify(peerData.publicKey, payload['cid']);

                if (cid != null) {

                  try {
                    await unpin(this.ipfs, cid, true);
                  } catch (e) {
                  }

                  const {data: msgAck} = ack;

                  await this._handleAck(msgAck);
                }
              }
            } else if (type === 'retrieve') {
              // retrieve messages

              // only trusted relayed peers can retrieve messages
              if (this._trustedPeers.indexOf(peerData.cid) >-1 || this._trustedPeers.indexOf(peerData.publicKey) > -1) {

                // we need to verify this message
                const count = await verify(peerData.publicKey, payload['count']);

                if (count != null) {

                  const msgs = await this._retrieveMessages(peerData.publicKey, Number.parseInt(count));

                  const signedMsg = await sign(this._privateKeyArmored, this._privateKeyPass, JSON.stringify(msgs));

                  const retrieveAckData = randomData();

                  const respMsg = {
                    'payload': {
                      'response': signedMsg,
                      'type' : 'response'
                    },
                    'key': this._publicKey,
                    'ack' : {
                      data: retrieveAckData
                    }
                  };

                  const respEnc = await encrypt(peerData.publicKey, JSON.stringify(respMsg))

                  const repeat = setInterval(async () => {
                    await this._publish(peerData.address, respEnc);
                  }, 2500);

                  await this._publish(peerData.address, respEnc);

                  const {data: msgAck} = ack;

                  await this._handleAck(msgAck);

                  try {

                    await this._waitForAck(retrieveAckData);

                  } catch (err) {
                    logger.error('failed to wait for ack ' + err.toString());
                  } finally {
                    clearTimeout(repeat);
                  }
                }
              }

            } else if (type === 'response') {
              // we will only handle response messages
              // from a relay peer
              if (this._relays.indexOf(peerData.cid) > -1 || this._relays.indexOf(peerData.publicKey) > -1) {

                const messages = await verify(peerData.publicKey, payload['response']);

                if (messages != null) {

                  const msgs = JSON.parse(messages);

                  logger.debug('Received ' + msgs.length + ' retrieved messages.');

                  for (const message of msgs) {

                    const data = await cat(this.ipfs, message, '15s');

                    if (data != null) {
                      logger.debug('Handling retrieved message ' + peer.address);
                      await this._publish(peer.address, data);
                    }
                  }

                  const {data: msgAck} = ack;

                  await this._handleAck(msgAck);

                }
              }
            } else if (type === 'relay') {

              // If the address is itself, and the relayMsg
              // is a signed piece of data from the relay requester
              // then the relay will be able to continue

              // Handle Direct Relay Messages
              if (this._relayMessages !== true) {
                return;
              }

              await checkHits(msg.from);

              const {data: relayMsg, peer: relayPeer, reply} = payload;

              const store = payload.hasOwnProperty('store')  && (typeof payload['store']) === 'boolean' ? payload['store'] : false;

              const {address: topic, cid: relayCid, publicKey: relayKey} = await this._getPeerData(relayPeer);

              // we can only directly relay data to peers we've already trusted
              if (this._trustedPeers.indexOf(relayCid) > -1 || this._trustedPeers.indexOf(relayKey) > -1) {

                // We can't really trust this message. but what is there not to trust?
                // we're only sending it off somewhere!
                const {data: relayAckData} = ack;

                logger.debug('Relaying direct message to: ' + topic);

                // we do this to attempt to support the
                // delivery of the callback response
                if (reply === true) {
                  logger.debug('Reply wanted, attempting temporary pass-through relay...');
                  try {
                    // We will relay this for about 2 minutes
                    await this.relayPeer(key, true, 1000 * 120);
                  } catch (ignored) {
                  }
                }

                let repeat = -1;

                if (store === false) {
                  // Begin relaying!
                  repeat = setInterval(async () => {
                    await this._publish(topic, relayMsg);
                  }, 2500);

                  await this._publish(topic, relayMsg);
                }

                try {

                  const msgHash = this._storeMessage(payload)

                  if (payload.hasOwnProperty('storeAck') && store === true) {
                    const {data: storeAck} =  payload['storeAck'];
                    await this._handleAck(storeAck);
                    return;
                  }

                  const detectedAckData = await this._waitForAck(relayAckData, '90s');

                  if (detectedAckData === relayAckData) {
                    try {
                      await this.ipfs.files.rm(msgHash);
                    } catch (e) {
                      logger.error('Failed to delete message from temporary storage: ' + msgHash + ' ' + e.toString())
                    }
                  } else {
                    logger.debug('Failed to relay direct message to: ' + topic);
                  }
                } catch (err) {
                  logger.error('Relay Ack Error: ' + err.toString());
                } finally {
                  clearTimeout(repeat);
                }
              }
            } else if (type === 'reply') {

              await checkHits(msg.from);

              const {message, replyId} = payload;
              const replyPublicKey = this._replyHosts.get(replyId);
              this._replyHosts.delete(replyId);

              // was the message received by the peer we sent it to?
              const verified = await verify(replyPublicKey, message);

              if (verified != null) {

                if (this._replyCallbacks.has(replyId)) {
                  const replyCb = this._replyCallbacks.get(replyId);
                  this._replyCallbacks.delete(replyId);

                  try {
                    replyCb(verified);
                  } catch (err) {
                  } finally {
                    const {data: replyAck} = ack;
                    await this._handleAck(replyAck);
                  }
                }
              } else {
                logger.error('Invalid reply signature received: ' + message);
              }
            }
            // end processing
          } catch (err) {
            logger.error('Processing Error: ' + err.toString());
          }
        };

        const peerData = await this._getPeerData(this._publicKey);

        await node.pubsub.subscribe(peerData.address, receiveMsg);

        logger.debug('Subscribing to messages destined for this peer...');

        this._subscriptions.set(peer.address, receiveMsg);
        this._relayedPeers.set(peer.address, true);
        accept();
      } catch (err) {
        logger.error('Subscription failure: ' + err);
        reject(err);
      }
    });
  }

  /**
   * When this is called, the peer will encrypt a payload including the address
   * and the message. After the payload is encrypted using the destination peers
   * public key, the data will then be sent over IPFS pubsub. The peer will
   * attempt to send the payload directly and it will also send a direct relay
   * message to any configured relays.
   *
   * @param peer the peer you wish to send the message to
   * @param address an internal address for the peer to identify messages with
   * @param msg the message you wish to send
   * @param timeout the maximum amount of time you wish to wait for an acknowledgement
   * @param callback a callback you wish to receive replies on
   * @returns {Promise<>} a promise that will complete when a message acknowledgement is received.
   */
  pub(peer, address, msg, timeout, callback) {

    let config = ((typeof timeout) === 'object') ? timeout : {};
    callback = ((typeof callback) === 'function') ? callback : ((typeof timeout) === 'function') ? timeout : null;
    config['timeout'] = ((typeof timeout) === 'string') ? timeout : '180s';
    config['waitForReply'] = config.hasOwnProperty('waitForReply') ? config['waitForReply'] : true;
    config['relayMessage'] = config.hasOwnProperty('relayMessage') ? config['relayMessage'] : true;
    config['storeMessage'] = config.hasOwnProperty('storeMessage') ? config['storeMessage'] : false;


    return this._broadcast(peer, "msg", {
      "address" : address,
      "message" : msg
    }, config, callback);

  }

  /**
   * pin will broadcast a message to a peer or list of peers signaling them to pin
   * the specified CID. It will then wait until it receives an acknowledgement. If an
   * acknowledgement is not received, it will throw an exception.
   *
   * @param peerOrPeers the peer or list of peers you wish to pin the data to
   * @param cid the CID you wish to pin
   * @param timeout an optional timeout for the amount of time you want to wait for a reply.
   * @returns {Promise} returns a Promise
   */
  async pin(peerOrPeers, cid, timeout) {
    timeout = timeout ? timeout : '5m';

    logger.info('Attempting to pin \"' +cid + '\"...')

    const signedCid = await sign(this._privateKeyArmored, this._privateKeyPass, cid);

    const payload = {
      'type': 'pin',
      'cid': signedCid,
    }

    let config = {
      waitForReply : true,
      relayMessage: true,
      storeMessage: false,
      timeout: timeout
    }

    const peers = peerOrPeers.constructor === [].constructor ? peerOrPeers : [peerOrPeers]

    const pubs = [];

    for (const peer of peers) {
      pubs.push(this._broadcast(peer, "pin", payload, config))
    }

    pubs.push(new Promise((r) => {
      logger.info('Finished pinning \"' +cid + '\"...')

      r();
    }))

    try {
      return Promise.all(pubs);
    } catch (e) {
      return Promise.reject(e);
    }
  }

  async unpin(peerOrPeers, cid, timeout) {
    timeout = timeout ? timeout : '240s';

    const signedCid = await sign(this._privateKeyArmored, this._privateKeyPass, cid);

    const payload = {
      'type': 'pin',
      'cid': signedCid,
    }

    let config = {
      waitForReply : true,
      relayMessage: true,
      storeMessage: false,
      timeout: timeout
    }

    const peers = peerOrPeers.constructor === [].constructor ? peerOrPeers : [peerOrPeers]

    const pubs = [];

    for (const peer of peers) {
      pubs.push(this._broadcast(this._publicKey, "unpin", payload, config))
    }
    try {
      return Promise.all(pubs);
    } catch (e) {
      return Promise.reject(e);
    }
  }
  /**
   * This will return true if there is a hash-lock held on a specific address.
   *
   * @param address
   * @param timeout
   * @returns {Promise<boolean|boolean>}
   */
  async locked(address, timeout) {
    if (this.localLocks.has(address)) {

      const oldLockAckData = this.localLocks.get(address);
      const oldAckHash = await Hash.of(Buffer.from(oldLockAckData));

      // Let's check if the last lock has been unlocked
      const old = await cat(this.ipfs, oldAckHash, '15s');

      if (old == null) {
        return true;
      }
    }
    return false;
  }

  async unlock(address, timeout) {
    timeout = timeout ? timeout : '120s';

    const signedAddr = await sign(this._privateKeyArmored, this._privateKeyPass, address);

    const payload = {
      'type': 'unlock',
      'address': signedAddr,
    }

    // Note this ack only exist for the original lock holder.
    const unlockAck = randomData();

    let config = {
      waitForReply : false,
      relayMessage: true,
      storeMessage: false,
      timeout: timeout,
      msgAck: unlockAck
    }

    logger.info('Attempting to broadcast unlock for the address \"' + address + "\"...")

    try {

      this.localUnlocks.set(address, unlockAck);

      if (this.localLocks.has(address)) {
        await this._handleAck(this.localLocks.get(address));
      }
      await this._broadcast(this._publicKey, "unlock", payload, config);
      this.localUnlocks.delete(address);
      this.localLocks.delete(address);

      return Promise.resolve();
    } catch (e) {
      this.localUnlocks.delete(address);
      return Promise.reject(e);
    }
  }

  /**
   * This will attempt to create a distributed lock by signaling other
   * peers in this peer group a lock wants to be held on a specified
   * address.
   *
   * @param address
   * @param handler
   * @param until
   * @returns {Promise<unknown>}
   */
  async lock(address, handler, until) {
    until = until ? until : '120s';

    // Let's check if there's already a lock
    // held on this address.
    if (this.localLocks.has(address)) {

      const oldLockAckData = this.localLocks.get(address);
      const oldAckHash = await Hash.of(Buffer.from(oldLockAckData));

      // Let's check if the last lock has been unlocked
      const old = await cat(this.ipfs, oldAckHash, '15s');

      if (old == null) {
        throw "It looks like the address \"" + address + "\" is already locked!";
      }
    }

    // Let's go ahead and sign this address so we can
    // signal the other peers in this group that we're
    // attempting to lock a specific address.
    const signedAddr = await sign(this._privateKeyArmored, this._privateKeyPass, address);

    const payload = {
      'type': 'lock',
      'address': signedAddr,
    }

    const lockAck = randomData();

    let config = {
      waitForReply : false,
      relayMessage: true,
      storeMessage: false,
      timeoutError: false,
      timeout: until,
      msgAck : lockAck
    }


    return new Promise(async (accept, reject) =>{
      try {

        // Set the lock locally, and store the lock
        // acknowledgement.
        this.localLocks.set(address, lockAck);

        let workFinished = false;

        // Let's broadcast this lock
        this._broadcast(this._publicKey, "lock", payload, config).then(async () => {
          // If we receive an acknowledgement and didn't time out, that means the work has finished
          if (!workFinished) {
            logger.warn('Timeout reached while waiting for work to complete.');
          } else {
            logger.debug('Finished work and holding lock for the address \"' + address + "\"...");
          }
          try {
            if (this.localUnlocks.has(address)) {
              await this._handleAck(this.localUnlocks.get(address));
            }
          } finally {
            this.localLocks.delete(address);
            accept();
          }
        }).catch((err) => {
          reject(err);
        });

        try {
          if ((typeof handler) === 'function') {
            // Let's go ahead and run the lock handler
            await handler();

            // Once it's finished, we can go ahead and handle
            // the lock acknowledgement signaling the broadcast
            // event to stop
            workFinished = true;
            await this._handleAck(lockAck);
          }
        } catch (e) {
        }

      } catch (e) {
        this.localLocks.delete(address);
        await this._handleAck(lockAck);

        reject(e);
      }
    });
  }
}

export default Peer

