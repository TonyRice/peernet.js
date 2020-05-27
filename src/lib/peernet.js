import IPFS from "ipfs";
import Hash from 'ipfs-only-hash';
import sha1 from 'crypto-js/sha1.js';
import Base64 from 'crypto-js/enc-base64.js';
import ipfsClient from 'ipfs-http-client';
import {generateKeyPair, sign, encrypt, decrypt, verify} from './util/crypto.js';
import {sleep, uuidv4, randomData} from './util/index.js';
import {add, cat, pin, connect, disconnect, DEFAULT_BOOTSTRAP, DEFAULT_BOOTSTRAP_BROWSER} from './util/ipfs.js';
import logger from './util/logger.js';

const PEERNET_BOOTSTRAP = [
  "/dns4/arthur.bootstrap.peernet.dev/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
  "/dns4/john.bootstrap.peernet.dev/tcp/4001/p2p/QmcSJKAznvnnVKyWbRhzJDTqLnp1LuNXS8ch9SwcR713bX",
  "/ip6/2607:9000:0:19:216:3cff:fe80:9c47/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
  "/ip6/2607:9000:0:28:216:3cff:fe80:9c47/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF"
];

const PEERNET_BOOTSTRAP_BROWSER = [
  "/dns4/arthur.bootstrap.peernet.dev/tcp/4002/wss/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
  "/dns4/john.bootstrap.peernet.dev/tcp/4002/wss/p2p/QmcSJKAznvnnVKyWbRhzJDTqLnp1LuNXS8ch9SwcR713bX"
];

class Peer {
  _started = false;

  _bootstraps;
  _proxyMode;
  _proxyHost;

  _publicKey;
  _privateKey;
  _privateKeyArmored;
  _privateKeyPass;

  _relayMessages;
  _handleMessages;

  _passthrough;
  _passthroughPeers;

  _checkPubAcks;
  _ackExists;
  _storeAck;

  _relays;
  _relayPeers;
  _relayedPeers = new Map();

  _subscriptions = new Map();

  _replyHosts = new Map();
  _msgCache = new Map();

  _replyCallbacks = new Map();
  _peerPubKeyCache = new Map();

  _config;

  _bootstrapTimer = -1;

  // Note: private methods are declared as variables for
  // NodeJS 12.x.x support
  _checkInitialized = () => {
    if (this.ipfs !== null && this._started === true) {
      return;
    }

    throw "Not initialized!";
  }

  _doPeerCheck = async () => {
    // let's check for any dead peers
    const peers = await this.ipfs.swarm.peers();

    for (const peer of peers) {
      try {
        let pass = false;
        for await (const ping of (this.ipfs.ping(peer.peer, {
          'timeout': '5s'
        }))) {
          if (ping.success === true) {
            pass = true;
            break;
          }
        }
        if (pass) {
          continue;
        }
        logger.info('Ping Failed: ' + JSON.stringify(peer))
      } catch (err) {
      }

      try {
        logger.info('Disconnecting from ' + peer.addr)
        await disconnect(this.ipfs, peer.addr);
        await sleep(150);
        logger.info('Connecting to ' + peer.addr)
        await connect(this.ipfs, peer.addr);
      } catch (err) {
        logger.error(err)
      }
    }
  }

  _reconnectBootstraps = async () => {
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
  }

  _storeMessage = async (peer) => {
    const peerData = await this._getPeerData(peer);

    // todo handle this
  }

  _retrieveMessages = async (peer, count) => {

    const peerData = await this._getPeerData(peer);

    const path = '/msgs/' + peerData.topic + '/';

    const files = await this.ipfs.files.ls(path);

    const msgs = [];

    for (const file of files) {
      if (msgs.length >= count) {
        break;
      }
      const cid = file.cid;
      msgs.push(cid);
      try {

        await this.ipfs.files.delete(path + file.name);
      } catch (e) {

      }
    }

    return msgs;
  }

  _getPeerData = (async (peer) => {
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

    const data = {
      'publicKey': peerPubKey,
      'address': Base64.stringify(address)
    }

    this._peerPubKeyCache.set(peer, data);

    return Promise.resolve(data);
  });

  constructor(config) {
    config = config ? config : {
      relays: []
    }

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
    this._relayPeers = config.relayPeers ? config.relayPeers : [];

    // this tells the node that it will receive and process messages directly.
    this._handleMessages = config.receive ? config.receive === true && this._passthrough === false : false;

    // If a peer is considered a single peer, it won't check for acks
    this._checkPubAcks = config.standalone ? config.standalone !== true : true;

    this._ackExists = (typeof config.ackExists) === 'function' ? config.ackExists : null;
    this._storeAck = (typeof config.storeAck) === 'function' ? config.storeAck : null;

    // this is where we will send any relay data to.
    // these nodes help ensure deliverability of our messages.
    this._relays = config.relays ? config.relays : [];

    this._config = config ? config : {};

    this._bootstrapTimer = -1;

  }

  async start() {
    return this.init();
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

      clearTimeout(this._retrieveTimer);
      clearTimeout(this._bootstrapTimer);
      clearTimeout(this._pingTimer);
    } finally {
      this._retrieveTimer = -1;
      this._bootstrapTimer = -1;
      this._pingTimer = -1;

      this.ipfs = null;
      this._started = false;
    }
  }

  init() {
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
        for (const peer of this._relayPeers) {
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

          const peer = await this._getPeerData(this._publicKey);

          // if this peer isn't subscribed to messages then we don't need
          // to check for any from any relays
          if (!this._relayedPeers.has(peer.address) && !this._handleMessages) {
            return;
          }

          for (const relayPeer of this._relays) {
            const relayAckData = randomData();
            const relayPeerData = await this._getPeerData(relayPeer);
            const relayPubKey = relayPeerData.publicKey;

            const retrieveMsg = {
              "payload": {
                'type': 'retrieve',
                'count': 15
              },
              "ack": {
                "data": relayAckData
              },
              "key": this._publicKey
            };

            const encrypted = await encrypt(relayPubKey, retrieveMsg);

            await node.pubsub.publish(relayPeerData.address, encrypted);

            const relayTimeout = setInterval(async () => {
              await node.pubsub.publish(relayPeerData.address, encrypted);
            }, 1500);

            const ackHash = await Hash.of(Buffer.from(relayAckData));
            const ackData = await cat(node, ackHash, '15s');

            if (ackData === relayAckData) {

            } else {
              logger.debug('Failed to retrieve messages from the relay: ' + relayPeerData);
            }

            clearTimeout(relayTimeout);
          }

        }, 30000);

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
                this._relayedPeers.remove(peerData.address);
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
    this._relayMessages = passthrough === true ? false : this._handleMessages;

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
              delete hitTimers[from]
              delete msgHits[from];
            }, 15000);

          } else {
            if (this._relayedPeers)
            // If we have more than 50 messages within 15 seconds
            // it's pretty safe to assume they're sending too many
            // messages

            // TODO make this configurable
              if (hits > 50) {
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

            const decrypted = await decrypt(this._privateKeyArmored, this._privateKeyPass, msgData);

            const _data = JSON.parse(decrypted);

            const {ack, payload, key} = _data;

            const {type} = payload;

            // let's go ahead and craft a reply.
            const peerData = await this._getPeerData(key);

            this._msgCache.set(msgData, true);

            setTimeout(() => {
              try {
                this._msgCache.delete(msg);
              } catch (ignored) {
              }
            }, 60000 * 5);

            if (type === 'msg') {
              // handle direct messages

              if (this._handleMessages !== true) {
                return;
              }

              await checkHits(msg.from);

              const {data: msgAck} = ack;

              const ackHash = await Hash.of(Buffer.from(msgAck));

              if (this._checkPubAcks === true) {
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
                    return null;
                  }
                }
              }

              try {
                let replyResult = null;
                if ((typeof handler) === 'function') {
                  const result = await handler(payload.address, payload.message);
                  if (result != null) {
                    replyResult = result;
                  }
                }

                // the client is expecting a reply...
                if (payload.hasOwnProperty('replyId')) {

                  logger.debug('Sending reply...');

                  const signedMsg = await sign(this._privateKeyArmored, this._privateKeyPass,
                    replyResult != null ? replyResult.toString() : '');

                  // can we possible return a list of peers to bootstrap from?

                  // sign the payload
                  const replyData = {
                    "payload": {
                      "reply": {
                        'type': 'reply',
                        'message': signedMsg,
                        'replyId': payload['replyId']
                      }
                    },
                    "key": this._publicKey
                  };

                  const replyEnc = await encrypt(peerData.publicKey, JSON.stringify(replyData))

                  await node.pubsub.publish(peerData.address, replyEnc);

                }
              } catch (err) {
                logger.error('Failed to process message: ' + err);
              }

              // begin message acknowledgement
              // Note: is this resilient as it could be ?
              // ideally the nodes acknowledging the message
              // should
              const ackCid = await add(node, msgAck);

              try {
                await pin(node, ackCid);
              } catch (ignored) {
              }

              // run our custom function
              // to store the ack
              if (this._storeAck !== null) {
                try {
                  this._storeAck(ackCid);
                } catch (err) {
                  logger.error(err);
                }
              }

              logger.debug('Acknowledgement added: ' + ackCid);

              if (_data.hasOwnProperty('relayAck')) {
                const relayAcks = _data.relayAck;
                for (const relayAck of relayAcks) {
                  const relayAckCid = await add(node, relayAck);
                  try {
                    await pin(node, relayAckCid);
                  } catch (ignored) {
                  }
                  logger.debug('Relay acknowledgement added: ' + relayAckCid);
                }
              }

            } else if (type === 'retrieve') {

              // only trusted relayed peers can retrieve messages
              if (this._relayedPeers.has(peerData.address)) {

                // we need to verify this message
                const count = await verify(peerData.publicKey, payload['count']);

                if (count != null) {

                  const msgs = await this._retrieveMessages(peerData.publicKey, count);

                  const signedMsg = await sign(this._privateKeyArmored, this._privateKeyPass, JSON.stringify(msgs));

                  const respMsg = JSON.stringify({
                    'payload': {
                      'response': signedMsg
                    },
                    'key': this._publicKey
                  });

                  const repeat = setInterval(async () => {
                    await node.pubsub.publish(peerData.address, respMsg);
                  }, 2500);

                  await node.pubsub.publish(peerData.address, respMsg);

                  const {data: msgAck} = ack;

                  const ackCid = await add(node, msgAck);

                  try {
                    await pin(node, ackCid);
                  } catch (ignored) {
                  }

                  // run our custom function
                  // to store the ack
                  if (this._storeAck !== null) {
                    try {
                      this._storeAck(ackCid);
                    } catch (err) {
                      logger.error(err);
                    }
                  }

                  logger.debug('Retrieve acknowledgement added: ' + ackCid);

                  try {


                    const {data: retrieveAckData} = ack;

                    const retrieveAckHash = await Hash.of(Buffer.from(retrieveAckData));

                    // let's relay this until we got the ack.
                    const detectedAckData = await cat(node, retrieveAckHash, '30s');

                    if (detectedAckData === retrieveAckData) {
                      logger.debug('Retrieve ack received! ' + retrieveAckHash);
                    }

                  } catch (err) {
                    logger.error(err);
                  } finally {
                    clearTimeout(repeat);
                  }
                }
              }

            } else if (type === 'response') {
              // we will only handle response messages
              // from a relay peer
              if (this._relayPeers.has(peerData.address)) {
                const messages = await verify(peerData.publicKey, payload['response']);

                if (messages != null) {

                  const msgs = JSON.parse(messages);

                  logger.debug('Received ' + msgs.length + ' retrieved messages.');

                  // TODO how do we handle this???
                  for (const message of msgs) {
                    const data = await cat(this.ipfs, message, '15s');

                    if (data != null) {
                      logger.debug('Handling retrieved message');
                      await this.ipfs.pubsub.publish(peer.address, data);
                    }
                  }
                }
              }
            } else if (type === 'relay') {
              // Handle Direct Relay Messages

              if (this._relayMessages !== true) {
                return;
              }

              await checkHits(msg.from);

              const {data: relayMsg, peer: relayPeer, reply} = payload.relay;

              const {address: topic} = await this._getPeerData(relayPeer);

              // we can only relay messages
              // destined for any peers we trust
              if (this._relayedPeers.has(topic)) {

                // We can't really trust this message. but what is there not to trust?
                // we're only sending it off somewhere!

                logger.debug('Relaying direct message to: ' + topic);

                // we do this to attempt to support the
                // delivery of the callback response
                if (reply === true) {
                  logger.debug('Reply wanted, attempting temporary pass-through relay...')
                  try {
                    // We will relay this for about 2 minutes
                    await this.relayPeer(key, true, 1000 * 120);
                  } catch (ignored) {
                  }
                }

                // what if we're relaying a bunch of messages?

                // Begin relaying!
                const repeat = setInterval(async () => {
                  await node.pubsub.publish(topic, relayMsg);
                }, 2500);

                await node.pubsub.publish(topic, relayMsg);

                try {

                  const {data: relayAckData} = ack;

                  const relayAckHash = await Hash.of(Buffer.from(relayAckData));

                  // let's relay this until we got the ack.
                  const detectedAckData = await cat(node, relayAckHash, '30s');

                  if (detectedAckData === relayAckData) {
                    logger.debug('Relay ack received! ' + relayAckHash)
                  } else {
                    if (detectedAckData === null) {

                      // Let's store this message to be retrieved later
                      const msgHash = '/msgs/' + topic + '/' + uuidv4();

                      await this.ipfs.files.write(msgHash, relayMsg, {
                        create: true,
                        parents: true
                      });
                    }
                  }

                } catch (err) {
                  logger.error(err);
                } finally {
                  clearTimeout(repeat);
                }
              }
            } else if (type === 'reply') {

              await checkHits(msg.from);

              const {message, replyId} = payload.reply;
              const replyPublicKey = this._replyHosts.get(replyId);
              this._replyHosts.delete(replyId);

              // was the message received by the peer we sent it to?
              const verified = await verify(replyPublicKey, message);

              if (verified != null) {

                if (this._replyCallbacks.has(replyId)) {
                  const replyCb = this._replyCallbacks.get(replyId);
                  this._replyCallbacks.delete(replyId);

                  try {
                    replyCb(null, verified);
                  } catch (err) {
                  }
                }
              } else {
                logger.error('Invalid reply signature received: ' + message);
              }
            }
            // end processing
          } catch (err) {
            logger.error(err);
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
   * @param callback a callback you wish to receive replies on
   * @returns {Promise<>} a promise that will complete when a message acknowledgement is received.
   */
  pub(peer, address, msg, timeout, callback) {
    timeout = ((typeof timeout) === 'string') ? timeout : '120s';
    callback = ((typeof callback) === 'function') ? callback : ((typeof timeout) === 'function') ? timeout : null;

    return new Promise(async (finished, failed) => {
      try {
        this._checkInitialized();


        // retrieve the peer data for the
        // peer we wish to send a message to.
        const node = this.ipfs,
          peerData = await this._getPeerData(peer);

        // generate message acknowledgement data
        const msgAck = randomData();

        // generate message acknowledgement data for
        // each relay.
        const relayAcks = this._relays.map(() => {
          return randomData()
        });

        let replyId = null;

        // generate a reply id and store the peer
        // and the function we want to trigger
        // as a callback.
        if ((typeof callback) === 'function') {
          replyId = uuidv4();
          this._replyCallbacks.set(replyId, callback);
          this._replyHosts.set(replyId, peerData.publicKey);
        }

        // create the payload that will be
        // sent to the peer.
        const jsonData = {
          "payload": {
            "type": "msg",
            "address": address,
            "message": msg,
            "replyId": replyId
          },
          "ack": {
            "data": msgAck
          },
          "key": this._publicKey,
          "relayAck": relayAcks // this is where the peer needs to send an ack back
        };

        // encrypt the data
        const encrypted = await encrypt(peerData.publicKey, JSON.stringify(jsonData));

        const data = Buffer.from(encrypted);

        const peerAddress = peerData.address;

        // publish the data immediately
        await node.pubsub.publish(peerAddress, data);

        const repeat = setInterval(async () => {
          await node.pubsub.publish(peerAddress, data);
        }, 2500);

        const timeouts = [];

        // Publish the message to the relay peers
        for (const relayPeer of this._relays) {
          const idx = this._relays.indexOf(relayPeer);
          const relayAckData = relayAcks[idx];
          const relayPeerData = await this._getPeerData(relayPeer);
          const relayPubKey = relayPeerData.publicKey;

          const relayMsg = JSON.stringify({
            'payload': {
              'relay': {
                'type': 'relay',
                'data': encrypted,
                'peer': peerData.publicKey,
                "reply": replyId != null // tell the relay to attempt to relay replies
              }
            },
            'key': this._publicKey,
            'ack': {
              'data': relayAckData
            }
          });

          const encryptedRelay = await encrypt(relayPubKey, relayMsg);

          logger.debug('Relaying message to peer ' + relayPeerData.address);

          await node.pubsub.publish(relayPeerData.address, encryptedRelay);

          const relayTimeout = setInterval(async () => {
            await node.pubsub.publish(relayPeerData.address, encryptedRelay);
          }, 5000);

          timeouts.push(relayTimeout);
        }

        try {

          timeouts.push(setTimeout(async () => {
            await this._doPeerCheck();
          }, 15000))

          // does the acknowledgement exist?
          const ackHash = await Hash.of(Buffer.from(msgAck));
          const ackData = await cat(node, ackHash, timeout);

          // since the data was added to IPFS, we know the peer
          // received the data.
          if (ackData === msgAck) {
            finished();
          } else {
            if (ackData == null) {
              failed('Timeout reached while waiting for a reply or acknowledgement.');
            } else {
              // todo a better error
              failed('Invalid ack data 0.o which is normally impossible.');
            }
          }
        } catch (err) {
          failed('Timeout reached while waiting for a reply or acknowledgement.');
        } finally {
          clearTimeout(repeat);
          clearTimeout(timeout);

          for (const t of timeouts) {
            clearTimeout(t);
          }
        }
      } catch (err) {
        failed(err);
      }
    });
  }
}

export default Peer

