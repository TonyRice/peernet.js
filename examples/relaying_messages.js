import Peer from '../src/esm.js';

(async () => {
    try {
        const peer = new Peer({
            privateKeyPass: 'thisisonlyademorelay',
            publicKey: 'publicKeyText',
            privateKey: 'privateKeyText'
        });

        await peer.passthrough(true).relay(true).start();

        await peer.sub();

        const relayPeer = '';

        // this will allow messages to be relayed directly
        // and in pass-through mode.
        await peer.relayPeer(relayPeer);
        await peer.relayPeer(relayPeer, true);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
