const IPFS = require('ipfs')
const openpgp = require('openpgp');
const sha1 = require('crypto-js/sha1');
const Base64 = require('crypto-js/enc-base64');
const isBrowser = (typeof window) !== 'undefined';

if (!isBrowser) {
    ipfsClient = require('ipfs-http-client');
}

const Hash = require('ipfs-only-hash');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function uuidv4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}


const hostCache = new Map();
async function getHostData(ipfs, host) {

    // todo attempt to validate.
    if (hostCache.has(host)) {
        return Promise.resolve(hostCache.get(host));
    }

    let hostPubKey;

    if (host.trim().indexOf('-----BEGIN PGP PUBLIC KEY BLOCK-----') === 0) {
        hostPubKey = host;
    } else {
        try {

            const stream = ipfs.cat(host, {'timeout': '60s'});

            let data = ''

            for await (const chunk of stream) {
                data += chunk.toString()
            }

            hostPubKey = data;
        } catch (e) {
            return Promise.reject(e);
        }
    }

    const address = sha1(hostPubKey.replace('\r\n', '').replace('\n').trim() + '.address');

    const data = {
        'publicKey': hostPubKey,
        'address': Base64.stringify(address)
    }

    hostCache.set(host, data);

    return Promise.resolve(data);
}

function generateRandomData() {
    // this will be used for generating things like acks and such

    return uuidv4()
}


const msgCache = new Map();
const relayKeyMap = new Map();

class PeerNet {

    constructor(config) {
        config = config ? config : {
            relays: []
        }

        this.bootstraps = config.bootstrap ? config.bootstrap : [];

        this.proxyMode = config.proxy ? config.proxy === true : false;
        this.publicKey = config.publicKey ? config.publicKey : null;
        this.privateKey = config.privateKey ? config.privateKey : null;
        this.privateKeyPass = config.privateKeyPass ? config.privateKeyPass : null;
        this.relayMessages = config.relay ? config.relay === true : false;

        // relay hosts are peers
        // you wish to attempt
        // to relay data through
        // these nodes are very public.
        this.relays = config.relays ? config.relays : [];
    }

    init() {
        const self = this;
        if (self.ipfs != null) {
            return Promise.resolve({
                publicKey: this.publicKey,
                privateKey: this.privateKeyArmored
            });
        }

        return new Promise(async (accept, reject) => {

            if (this.privateKey != null) {

                const {keys: [privateKey]} = await openpgp.key.readArmored(this.privateKey);

                this.privateKeyArmored = this.privateKey;

                try {
                    await privateKey.decrypt(this.privateKeyPass);
                } catch (e) {
                    return reject(e);
                }

                this.privateKey = privateKey;

            } else {
                this.privateKeyPass = this.privateKeyPass != null ? this.privateKeyPass : uuidv4();

                // A client key is generated on each use. It is only used by the browser during the instance
                // session.
                const {privateKeyArmored, publicKeyArmored, revocationCertificate} = await openpgp.generateKey({
                    userIds: [{name: uuidv4(), email: 'web-client@peernet.dev'}], // you can pass multiple user IDs
                    curve: 'ed25519',
                    passphrase: this.privateKeyPass
                });

                const {keys: [privateKey]} = await openpgp.key.readArmored(privateKeyArmored);

                await privateKey.decrypt(this.privateKeyPass);

                this.privateKey = privateKey;
                this.privateKeyArmored = privateKeyArmored;
                this.publicKey = publicKeyArmored;
            }

            let node;

            if (this.proxyMode === true) {
                node = ipfsClient('http://localhost:5001');
                await node.id()
                self.ipfs = node;
            } else {
                let options;

                // The browser uses a different set of bootstrap nodes.
                if ((typeof window) === 'undefined') {
                    options = {
                        config: {
                            // If you want to connect to the public bootstrap nodes, remove the next line
                            Bootstrap: this.bootstraps.concat([
                                "/ip4/107.152.37.101/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
                                "/ip6/2607:9000:0:19:216:3cff:fe80:9c47/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
                                "/ip6/2607:9000:0:28:216:3cff:fe80:9c47/tcp/4001/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
                                '/dns4/nyc-1.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLueR4xBeUbY9WZ9xGUUxunbKWcrNFTDAadQJmocnWm',
                                '/dns4/nyc-2.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64',
                                '/dns4/ams-1.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd',
                                '/dns4/lon-1.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLMeWqB7YGVLJN3pNLQpmmEk35v6wYtsMGLzSr5QBU3',
                                '/dns4/sfo-3.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM',
                                '/dns4/sgp-1.bootstrap.libp2p.io/tcp/4001/p2p/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu',
                                '/dns4/node0.preload.ipfs.io/tcp/4001/p2p/QmZMxNdpMkewiVZLMRxaNxUeZpDUb34pWjZ1kZvsd16Zic',
                                '/dns4/node1.preload.ipfs.io/tcp/4001/p2p/Qmbut9Ywz9YEDrz8ySBSgWyJk41Uvm2QJPhwDJzJyGFsD6',
                            ])
                        }
                    }
                } else {
                    options = {
                        repo: 'ipfs-' + Math.random(),
                        config: {
                            Addresses: {
                                Swarm: [
                                    // This is a public webrtc-star server
                                    // '/dns4/star-signal.cloud.ipfs.team/tcp/443/wss/p2p-webrtc-star'
                                    //'/ip4/127.0.0.1/tcp/13579/wss/p2p-webrtc-star'
                                ]
                            },
                            // If you want to connect to the public bootstrap nodes, remove the next line
                            Bootstrap: this.bootstraps.concat([
                                "/dns4/arthur.bootstrap.peernet.dev/tcp/4002/wss/p2p/QmaM3FbA8amt6WGeN9Zq7zz8EmGxwdcAeHtcAUx3SoxkWF",
                                '/dns4/ams-1.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLer265NRgSp2LA3dPaeykiS1J6DifTC88f5uVQKNAd',
                                '/dns4/lon-1.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLMeWqB7YGVLJN3pNLQpmmEk35v6wYtsMGLzSr5QBU3',
                                '/dns4/sfo-3.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLPppuBtQSGwKDZT2M73ULpjvfd3aZ6ha4oFGL1KrGM',
                                '/dns4/sgp-1.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLSafTMBsPKadTEgaXctDQVcqN88CNLHXMkTNwMKPnu',
                                '/dns4/nyc-1.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLueR4xBeUbY9WZ9xGUUxunbKWcrNFTDAadQJmocnWm',
                                '/dns4/nyc-2.bootstrap.libp2p.io/tcp/443/wss/ipfs/QmSoLV4Bbm51jM9C4gDYZQ9Cy3U6aXMJDAbzgu2fzaDs64',
                                '/dns4/node0.preload.ipfs.io/tcp/443/wss/ipfs/QmZMxNdpMkewiVZLMRxaNxUeZpDUb34pWjZ1kZvsd16Zic',
                                '/dns4/node1.preload.ipfs.io/tcp/443/wss/ipfs/Qmbut9Ywz9YEDrz8ySBSgWyJk41Uvm2QJPhwDJzJyGFsD6'
                            ])
                        }
                    }
                }

                node = await IPFS.create(options);
                await node.id()
                self.ipfs = node;
            }

            let waiting = true;

            setTimeout(() => {
                waiting = false
            }, 5000);

            while (waiting) {
                let peers = await node.swarm.peers();
                if (peers.length > 1) {
                    waiting = false;
                } else {
                    await sleep(150);
                }
            }

            // todo pin the ack temporarily.

            for await (const {cid} of node.add(this.publicKey)) {
                console.log('peernet.js: Your host public key alias is ' + cid.toString())
            }

            accept({
                publicKey: this.publicKey,
                privateKey: this.privateKeyArmored
            });
        })
    }

    relayPublic(host) {

        // this will go ahead and subscribe for data
        // destined for a specific host and publicly relay
        // it's data.
        return new Promise(async (a, r) => {

            if ((typeof window) !== 'undefined') {
                r('public relay support is not supported in the browser.');
                return;
            }
            const hostData = await getHostData(this.ipfs, host);

            if (relayKeyMap.has(hostData.address)) {
                r('This host is already being relayed.');
                return;
            }

            await this.ipfs.pubsub.subscribe(hostData.address, (msg) => {
            });

            relayKeyMap.set(hostData.address, true);
            a();
        });
    }

    relay(isRelay) {
        this.relayMessages = isRelay ? isRelay : false;
        return this;
    }

    sub(handler) {
        return new Promise(async (a, r) => {

            const host = await getHostData(this.ipfs, this.publicKey);

            const node = this.ipfs;

            if (relayKeyMap.has(host.address)) {
                r('This host is already receiving events.');
                return;
            }

            const receiveMsg = async (msg) => {
                try {

                    if (msgCache.has(msg)) {
                        return;
                    }

                    const {data: decrypted} = await openpgp.decrypt({
                        message: await openpgp.message.readArmored(msg.data.toString()),
                        privateKeys: [this.privateKey]
                    });

                    const _data = JSON.parse(decrypted);

                    const {ack, payload, key, reply} = _data;

                    const {data: ackData} = ack;

                    const ackHash = await Hash.of(Buffer.from(ackData));

                    try {

                        // does this ack exist internally too?

                        // Let's attempt to see if this ack already exists
                        // if it does, then we won't respond to the message.
                        const ackStream = node.cat(ackHash, {'timeout': '2s'})
                        let data = ''

                        for await (const chunk of ackStream) {
                            // chunks of data are returned as a Buffer, convert it back to a string
                            data += chunk.toString()
                        }

                        return;
                    } catch (ignored) {
                    }

                    msgCache.set(msg, true);

                    setTimeout(() => {
                        try {
                            msgCache.delete(msg);
                        } catch(ignored) {
                        }
                    }, 60000 * 5)

                    if (payload.hasOwnProperty('message')) {
                        try {
                            // push off to event loop
                            if ((typeof handler) === 'function') {
                                // push it off to the event loop
                                setImmediate(() => {
                                    handler(payload.address, payload.message)
                                });
                            }
                        } catch (e) {
                        }

                        // todo implement reply

                        for await (const {cid} of node.add(ackData)) {
                            console.log('peernet.js: ack added ' + cid.toString())
                        }

                        if (_data.hasOwnProperty('relays')) {
                            const relays = _data.relays;
                            for (const relayData of relays) {
                                // todo pin the ack temporarily.
                                for await (const {cid} of node.add(relayData)) {
                                    console.log('peernet.js: relay ack added ' + cid.toString())
                                }
                            }
                        }

                    } else if (payload.hasOwnProperty('relay')) {
                        if (this.relayMessages !== true) {
                            // ignore any relay messages.
                            return;
                        }

                        const {data, host} = payload.relay;

                        const {address: topic} = await getHostData(this.ipfs, host);

                        console.log('Relaying message to: ' + topic);

                        const repeat = setInterval(async () => {
                            await node.pubsub.publish(topic, data);
                        }, 2500);

                        await node.pubsub.publish(topic, data);

                        try {
                            // let's relay this until we got the ack.
                            const ackStream = node.cat(ackHash, {'timeout': '30s'})
                            let data = '';
                            for await (const chunk of ackStream) {
                                // chunks of data are returned as a Buffer, convert it back to a string
                                data += chunk.toString()
                            }

                            if (data === ackData) {
                                console.log('peernet.js: relay ack received ! ' + data);
                            }
                        } catch (ignored) {
                            // error timeout
                        } finally {
                            clearTimeout(repeat);
                        }
                    }
                    // end processing
                } catch (e) {
                    console.log('peernet.js: invalid payload');
                    console.log(e);
                }
            };

            const hostData = await getHostData(node, this.publicKey);

            await node.pubsub.subscribe(hostData.address, receiveMsg);

            relayKeyMap.set(host.address, true);
            a();
        });
    }

    pub(host, address, msg) {
        return this.init().then(async () => {

            const node = this.ipfs;

            const hostData = await getHostData(node, host);

            const msgAck = generateRandomData();

            const relayAcks = this.relays.map(() => {
                return generateRandomData()
            });

            const ack = {
                "data": msgAck
            };

            const pubData = {
                "payload": {
                    "address": address, // the internal address
                    "message": msg
                },
                "ack": ack,
                "key": this.publicKey,
                "relays": relayAcks // this is where the host needs to send an ack back
            };

            const {data: encrypted} = await openpgp.encrypt({
                message: openpgp.message.fromText(JSON.stringify(pubData)),
                publicKeys: (await openpgp.key.readArmored(hostData.publicKey + '\n')).keys
            });

            const topic = hostData.address;

            return new Promise(async (finished, failed) => {
                try {

                    const hash = await Hash.of(Buffer.from(msgAck));
                    const data = Buffer.from(encrypted);

                    await node.pubsub.publish(topic, data);

                    for (const relayHost of this.relays) {
                        setTimeout(async () => {
                            const idx = this.relays.indexOf(relayHost);
                            const relayAckData = relayAcks[idx];
                            const relayHostData = await getHostData(this.ipfs, relayHost);
                            const relayPubKey = relayHostData.publicKey;

                            // TODO - should we use workers?
                            const {data: encryptedRelay} = await openpgp.encrypt({
                                message: openpgp.message.fromText(JSON.stringify({
                                    'payload': {
                                        'relay': {
                                            'data': encrypted,
                                            'host': hostData.publicKey
                                        }
                                    },
                                    'key': this.publicKey,
                                    'ack': {
                                        'data': relayAckData
                                    }
                                })),
                                publicKeys: (await openpgp.key.readArmored(relayPubKey)).keys
                            });

                            await node.pubsub.publish(relayHostData.address, encryptedRelay);
                        }, 150);
                    }

                    const repeat = setInterval(async () => {

                        await node.pubsub.publish(topic, data);
                    }, 5000);

                    // every x amount of seconds, we will go ahead
                    // and publish this data until we receive an ack.

                    const tmp = {};
                    // if no reply, remove subscribe and timeout
                    const timeout = setTimeout(() => {
                        tmp['failed'] = true;
                        failed('Timeout hit while waiting for a reply or acknowledgement.');
                    }, 65000);

                    try {

                        const stream = node.cat(hash, {'timeout': '60s'});

                        let data = ''

                        for await (const chunk of stream) {
                            // chunks of data are returned as a Buffer, convert it back to a string
                            data += chunk.toString()
                        }

                        clearTimeout(repeat);
                        clearTimeout(timeout);

                        if (data === msgAck) {
                            finished();
                        } else {
                            failed('Invalid ack data 0.o which is normally impossible.');
                        }
                    } catch (e) {
                        failed(e);
                    }

                } catch (e) {
                    failed(e);
                }
            });
        });
    }
}

module.exports = PeerNet;