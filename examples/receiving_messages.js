import Peer from '../src/esm.js';

(async () => {
    try {
        const peer = new Peer({
            privateKeyPass: 'thisisonlyademorelay',
            publicKey: 'publicKeyText',
            privateKey: 'privateKeyText'
        });

        await peer.start();

        await peer.sub((address, msg) => {
            console.log('Got a message! ' + msg);
            return msg;
        });
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
