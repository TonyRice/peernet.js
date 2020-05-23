import IPFS from "ipfs";
import Hash from 'ipfs-only-hash';
import sha1 from 'crypto-js/sha1.js';
import Base64 from 'crypto-js/enc-base64.js';
import ipfsClient from 'ipfs-http-client';
import {generateKeyPair, sign, encrypt, decrypt, verify} from './util/crypto.js';
import {sleep, uuidv4, randomData} from './util/index.js';
import {add, cat, pin, connect, DEFAULT_BOOTSTRAP, DEFAULT_BOOTSTRAP_BROWSER} from './util/ipfs.js';
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
    #started = false;

    #bootstraps;
    #proxyMode;
    #proxyHost;

    #publicKey;
    #privateKey;
    #privateKeyArmored;
    #privateKeyPass;

    #relayMessages;
    #handleMessages;

    #passthrough;
    #passthroughPeers;

    #checkPubAcks;
    #ackExists;
    #storeAck;

    #relays;
    #relayPeers;
    #relayedPeers = new Map();

    #subscriptions = new Map();

    #replyHosts = new Map();
    #msgCache = new Map();

    #replyCallbacks = new Map();
    #peerPubKeyCache = new Map();

    #config;

    #bootstrapTimer = -1;

    // Note: private methods are declared as variables for
    // NodeJS 12.x.x support
    #checkInitialized = () => {
        if (this.ipfs !== null && this.#started === true) {
            return;
        }

        throw "Not initialized!";
    }

    #reconnectBootstraps = async () => {
        const peers = await this.ipfs.swarm.peers();
        const peerAddrs = peers.map((peer) => {
            return peer.addr.toString();
        });
        for (const addr of this.#bootstraps) {
            if (peerAddrs.indexOf(addr) === -1) {
                try {
                    logger.debug('Attempting to re-connect to IPFS node: ' + addr);
                    await connect(this.ipfs, addr);
                } catch (err) {
                    logger.error(err)
                }
            }
        }
    }

    #getPeerData = (async (peer) => {
        this.#checkInitialized();

        const ipfs = this.ipfs;

        // todo attempt to validate.
        if (this.#peerPubKeyCache.has(peer)) {
            return Promise.resolve(this.#peerPubKeyCache.get(peer));
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

        this.#peerPubKeyCache.set(peer, data);

        return Promise.resolve(data);
    });

    constructor(config) {
        config = config ? config : {
            relays: []
        }

        this.#bootstraps = config.bootstrap ? config.bootstrap : [];

        if ((typeof window) === 'object') {
            this.#bootstraps = this.#bootstraps.concat(PEERNET_BOOTSTRAP_BROWSER);
        } else {
            this.#bootstraps = this.#bootstraps.concat(PEERNET_BOOTSTRAP);
        }

        this.#proxyMode = config.proxy ? config.proxy === true : false;
        this.#proxyHost = config.proxyHost ? config.proxyHost : 'http://localhost:5001';
        this.#publicKey = config.publicKey ? config.publicKey : null;
        this.#privateKey = config.privateKey ? config.privateKey : null;
        this.#privateKeyPass = config.privateKeyPass ? config.privateKeyPass : null;

        // this will tell the server to act as a passthrough relay for it's own messages
        this.#passthrough = config.passthrough ? config.passthrough === true : false;

        // these are hosts we wish to handle data for in a passthrough manner.
        this.#passthroughPeers = config.passthroughPeers ? config.passthroughPeers : [];

        // this tells the node that it is able to relay messages directly
        this.#relayMessages = config.relay ? config.relay === true && this.#passthrough === false : false;
        // trusted hosts are hosts that we allow messages to be relayed
        // to if we are in relay mode.
        this.#relayPeers = config.relayPeers ? config.relayPeers : [];

        // this tells the node that it will receive and process messages directly.
        this.#handleMessages = config.receive ? config.receive === true && this.#passthrough === false : false;

        // If a peer is considered a single peer, it won't check for acks
        this.#checkPubAcks = config.standalone ? config.standalone !== true : true;

        this.#ackExists = (typeof config.ackExists) === 'function' ? config.ackExists : null;
        this.#storeAck = (typeof config.storeAck) === 'function' ? config.storeAck : null;

        // this is where we will send any relay data to.
        // these nodes help ensure deliverability of our messages.
        this.#relays = config.relays ? config.relays : [];

        this.#config = config ? config : {};

        this.#bootstrapTimer = -1;

    }

    async start() {
        return this.init();
    }

    async stop() {
        if (this.ipfs == null) {
            return Promise.reject('Peer not started!');
        }

        try {
            for (const entry of this.#subscriptions.entries()) {
                await this.ipfs.pubsub.unsubscribe(entry[0], entry[1]);
            }
            if (this.#proxyMode === false) {
                await this.ipfs.stop();
            }
        } finally {
            this.ipfs = null;
            this.#started = false;
        }
    }

    init() {
        if (this.ipfs != null && this.#started) {
            return Promise.resolve({
                publicKey: this.#publicKey,
                privateKey: this.#privateKey
            });
        }

        return new Promise(async (accept, reject) => {
            logger.info('Initializing...');

            try {

                if (this.#privateKey != null) {
                    this.#privateKeyArmored = this.#privateKey;
                } else {

                    logger.debug('Generating private/public keys...');

                    this.#privateKeyPass = this.#privateKeyPass != null ? this.#privateKeyPass : uuidv4();

                    // A client key is generated on each use. It is only used by the browser during the instance
                    // session.
                    const {privateKeyArmored, publicKeyArmored} = await generateKeyPair(uuidv4(), 'web-client@peernet.dev', this.#privateKeyPass)

                    this.#privateKeyArmored = privateKeyArmored;
                    this.#publicKey = publicKeyArmored;
                }

                logger.debug('Initializing IPFS...');

                let node;

                if (this.#proxyMode === true) {
                    node = ipfsClient(this.#proxyHost);
                    await node.id()
                    this.ipfs = node;
                } else {
                    let options;

                    // The browser uses a different set of bootstrap nodes.
                    if ((typeof window) === 'undefined') {
                        options = {
                            repo: this.#config.repo ? this.#config.repo : undefined,
                            config: {
                                // If you want to connect to the public bootstrap nodes, remove the next line
                                Bootstrap: this.#bootstraps.concat(DEFAULT_BOOTSTRAP)
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
                                Bootstrap: this.#bootstraps.concat(
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
                const peerCid = await add(node, this.#publicKey);

                logger.debug('Pinning peer CID: ' + peerCid);

                await pin(node, peerCid);

                logger.debug('Adding direct relay peers...');

                // these are hosts that we are relaying data for.
                // we need to add these to the this.#relayedPeers map
                // to tell the peer to allow these messages to be relayed
                for (const peer of this.#relayPeers) {
                    const peerData = await this.#getPeerData(peer);

                    // for non passthrough mode
                    // this must be false
                    this.#relayedPeers.set(peerData.address, false);
                }

                logger.debug('Configuring pass-through relay peers...');

                for (const peer of this.#passthroughPeers) {
                    await this.relayPeer(peer, true);
                }

                // This will attempt to keep things connected.
                this.#bootstrapTimer = setInterval(async () => {
                    await this.#reconnectBootstraps();
                }, 15000 * 3);

                this.#started = true;

                logger.info('Started! Your peer CID is: ' + peerCid);

                accept({
                    publicKey: this.#publicKey,
                    privateKey: this.#privateKeyArmored
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

            const peerData = await this.#getPeerData(peer);

            let originalValue = null;

            if (this.#relayedPeers.has(peerData.address)) {
                const value = this.#relayedPeers.get(peerData.address);

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
                this.#relayedPeers.set(peerData.address, originalValue != null ? originalValue : false);
                accept();
            } else {

                logger.debug('Relaying peer in pass-through mode with the public key: ' + peerData.publicKey);

                // we're passing an empty handler
                // just to sink data into and let
                // ipfs pass it off.
                const handler = () => {};

                await this.ipfs.pubsub.subscribe(peerData.address, handler);

                this.#subscriptions.set(peerData.address, handler);
                this.#relayedPeers.set(peerData.address, true);

                if (until > 0) {
                    setTimeout(async () => {
                        try {
                            await this.ipfs.pubsub.unsubscribe(peerData.address, handler)
                        } catch (err) {
                        } finally {
                            this.#subscriptions.delete(peerData.address);

                            // if the original value was anything other
                            // than null, that means this peer is a trusted
                            // relay peer. we just don't want to pass-through
                            // relay anymore
                            if (originalValue !== null) {
                                this.#relayedPeers.set(peerData.address, false);
                            } else {
                                this.#relayedPeers.remove(peerData.address);
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
        this.#passthrough = passthrough === true;
        this.#handleMessages = passthrough === true ? false : this.#handleMessages;
        this.#relayMessages = passthrough === true ? false : this.#handleMessages;

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
        this.#passthrough = receiveMessages === true ? false : this.#passthrough;

        this.#handleMessages = receiveMessages ? receiveMessages : true;
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
        this.#passthrough = relayMessages === true ? false : this.#passthrough;

        this.#relayMessages = relayMessages ? relayMessages : false;
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

                this.#checkInitialized();

                const peer = await this.#getPeerData(this.#publicKey);

                const node = this.ipfs;

                if (this.#relayedPeers.has(peer.address)) {
                    reject('This peer is already receiving events.');
                    return;
                }

                const receiveMsg = async (msg) => {
                    try {
                        // we don't need to do anything at all
                        if (this.#passthrough === true) {
                            return;
                        }

                        const msgData = msg.data.toString();

                        if (this.#msgCache.has(msgData)) {
                            return;
                        }

                        const decrypted = await decrypt(this.#privateKeyArmored, this.#privateKeyPass, msgData);

                        const _data = JSON.parse(decrypted);

                        const {ack, payload, key} = _data;

                        this.#msgCache.set(msgData, true);

                        setTimeout(() => {
                            try {
                                this.#msgCache.delete(msg);
                            } catch (ignored) {
                            }
                        }, 60000 * 5)

                        if (payload.hasOwnProperty('message')) {
                            // handle direct messages

                            if (this.#handleMessages !== true) {
                                return;
                            }

                            const {data: msgAck} = ack;

                            const ackHash = await Hash.of(Buffer.from(msgAck));

                            if (this.#checkPubAcks === true) {
                                if (this.#ackExists !== null) {
                                    const exists = await this.#ackExists();

                                    if (exists) {
                                        return true;
                                    }
                                } else {
                                    // this should be optimized - todo
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

                                    logger.debug('Sending reply...')

                                    // let's go ahead and craft a reply.
                                    const peerData = await this.#getPeerData(key);

                                    const signedMsg = await sign(this.#privateKeyArmored, this.#privateKeyPass,
                                        replyResult != null ? replyResult.toString() : '');

                                    // can we possible return a list of peers to bootstrap from?

                                    // sign the payload
                                    const replyData = {
                                        "payload": {
                                            "reply": {
                                                'message': signedMsg,
                                                'replyId': payload['replyId']
                                            }
                                        },
                                        "key": this.#publicKey
                                    };

                                    const replyEnc = await encrypt(peerData.publicKey, JSON.stringify(replyData))

                                    await node.pubsub.publish(peerData.address, replyEnc);

                                }
                            } catch (err) {
                                logger.error('Failed to process message', e);
                            }

                            // begin message acknowledgement
                            // Note: is this resilient as it could be ?
                            // ideally the nodes acknowledging the message
                            // should
                            const ackCid = await add(node, msgAck);

                            try {
                                await pin(node, ackCid);
                            } catch (ignored){}

                            if (this.#storeAck !== null) {
                                try {
                                    this.#storeAck(ackCid);
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
                                    } catch (ignored){}
                                    logger.debug('Relay acknowledgement added: ' + relayAckCid);
                                }
                            }

                        } else if (payload.hasOwnProperty('relay')) {
                            // Handle Direct Relay Messages

                            if (this.#relayMessages !== true) {
                                return;
                            }

                            const {data: relayMsg, peer: relayPeer, reply} = payload.relay;

                            const {address: topic} = await this.#getPeerData(relayPeer);

                            // only trusted peers can be here.
                            if (this.#relayedPeers.has(topic)) {

                                logger.debug('Relaying direct message to: ' + topic);

                                // does this relay have a reply route??
                                if (reply === true) {
                                    logger.debug('Reply wanted, attempting temporary pass-through relay...')
                                    try {
                                        await this.relayPeer(key, true, 1000 * 120);
                                    } catch (ignored) {
                                    }
                                }

                                // Begin relaying!
                                const repeat = setInterval(async () => {
                                    await node.pubsub.publish(topic, relayMsg);
                                }, 2500);

                                await node.pubsub.publish(topic, relayMsg);

                                try {

                                    const {data: relayAckData} = ack;

                                    const relayAckHash = await Hash.of(Buffer.from(relayAckData));

                                    // let's relay this until we got the ack.
                                    const detectedAckData = await cat(node, relayAckHash, '60s');

                                    if (detectedAckData === relayAckData) {
                                        logger.debug('Relay ack received! ' + relayAckHash)
                                    }
                                } catch (err) {
                                    logger.error(err);
                                } finally {
                                    clearTimeout(repeat);
                                }
                            }
                        } else if (payload.hasOwnProperty('reply')) {
                            // handle direct replies

                            const {message, replyId} = payload.reply;
                            const replyPublicKey = this.#replyHosts.get(replyId);
                            this.#replyHosts.delete(replyId);

                            // was the message received by the peer we sent it to?
                            const verified = await verify(replyPublicKey, message);

                            if (verified != null) {
                                if (this.#replyCallbacks.has(replyId)) {
                                    const replyCb = this.#replyCallbacks.get(replyId);
                                    this.#replyCallbacks.delete(replyId);

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

                const peerData = await this.#getPeerData(this.#publicKey);

                await node.pubsub.subscribe(peerData.address, receiveMsg);

                logger.debug('Subscribing to messages for the topic: ' + peerData.address);

                this.#subscriptions.set(peer.address, receiveMsg);
                this.#relayedPeers.set(peer.address, true);
                accept();
            } catch (err) {
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
        timeout = ((typeof timeout) === 'string') ? timeout : '60s';
        callback = ((typeof callback) === 'function') ? callback : ((typeof timeout) === 'function') ? timeout : null;

        return new Promise(async (finished, failed) => {
            try {
                this.#checkInitialized();


                // retrieve the peer data for the
                // peer we wish to send a message to.
                const node = this.ipfs,
                    peerData = await this.#getPeerData(peer);

                // generate message acknowledgement data
                const msgAck = randomData();

                // generate message acknowledgement data for
                // each relay.
                const relayAcks = this.#relays.map(() => {
                    return randomData()
                });

                let replyId = null;

                // generate a reply id and store the peer
                // and the function we want to trigger
                // as a callback.
                if ((typeof callback) === 'function') {
                    replyId = uuidv4();
                    this.#replyCallbacks.set(replyId, callback);
                    this.#replyHosts.set(replyId, peerData.publicKey);
                }

                // create the payload that will be
                // sent to the peer.
                const jsonData = {
                    "payload": {
                        "address": address,
                        "message": msg,
                        "replyId": replyId
                    },
                    "ack": {
                        "data": msgAck
                    },
                    "key": this.#publicKey,
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
                for (const relayPeer of this.#relays) {
                    const idx = this.#relays.indexOf(relayPeer);
                    const relayAckData = relayAcks[idx];
                    const relayPeerData = await this.#getPeerData(relayPeer);
                    const relayPubKey = relayPeerData.publicKey;

                    const relayMsg = JSON.stringify({
                        'payload': {
                            'relay': {
                                'data': encrypted,
                                'peer': peerData.publicKey,
                                'reply': replyId != null // tell the relay to attempt to relay replies
                            }
                        },
                        'key': this.#publicKey,
                        'ack': {
                            'data': relayAckData
                        }
                    });

                    const encryptedRelay = await encrypt(relayPubKey, relayMsg);

                    await node.pubsub.publish(relayPeerData.address, encryptedRelay);

                    const relayTimeout = setInterval(async () => {
                        await node.pubsub.publish(relayPeerData.address, encryptedRelay);
                    }, 5000);

                    timeouts.push(relayTimeout);
                }

                try {

                    // does the acknowledgement exist?
                    const ackHash = await Hash.of(Buffer.from(msgAck));
                    const ackData = await cat(node, ackHash, timeout);

                    clearTimeout(repeat);
                    clearTimeout(timeout);

                    for (const t of timeouts) {
                        clearTimeout(t);
                    }

                    // since the data was added to IPFS, we know the peer
                    // received the data.
                    if (ackData === msgAck) {
                        finished();
                    } else {
                        // todo a better error
                        failed('Invalid ack data 0.o which is normally impossible.');
                    }
                } catch (err) {
                    failed('Timeout reached while waiting for a reply or acknowledgement.');
                }
            } catch (err) {
                failed(err);
            }
        });
    }
}

export default Peer

