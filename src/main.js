import './vendor/wasm_exec.js';
import wasmUrl from '/cotilla.wasm?inline';
import SFrameWorker from './worker.js?worker&inline';

const PINNED_PUB_KEY = typeof __PINNED_PUB_KEY__ !== 'undefined' ? __PINNED_PUB_KEY__ : '';
const APP_ID = typeof __APP_ID__ !== 'undefined' ? __APP_ID__ : 'cotilla-chat';
const CHANNEL = typeof __CHANNEL__ !== 'undefined' ? __CHANNEL__ : 'stable';
const DIST_ROOM_ID = typeof __DIST_ROOM_ID__ !== 'undefined' ? __DIST_ROOM_ID__ : 'cotilla-app-dist-v1';
const SIGNALING_SERVER = typeof __SIGNALING_SERVER__ !== 'undefined' ? __SIGNALING_SERVER__ : 'localhost:8080';

function resolveSignalingUrl() {
  if (typeof window !== 'undefined') {
    try {
      const params = new URLSearchParams(window.location.search || '');
      const querySig = params.get('signaling');
      if (querySig && querySig.trim()) return querySig.trim();
    } catch {}

    if (window.location && window.location.host) {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      return `${proto}//${window.location.host}/ws`;
    }
  }

  const sigHost = typeof SIGNALING_SERVER !== 'undefined' && SIGNALING_SERVER ? SIGNALING_SERVER : 'localhost:8080';
  const proto = (typeof window !== 'undefined' && window.location && window.location.protocol === 'https:') ? 'wss:' : 'ws:';
  return `${proto}//${sigHost}/ws`;
}

const progressBar = document.getElementById('progress-bar');

let ws = null;
let downloadedBundle = false;
let identity = null;
let joinRes = null;
let wasmBytes = null;
let wasmModule = null;
let pollInterval = null;

async function getWasmBytes() {
  if (wasmBytes) return wasmBytes;
  if (typeof wasmUrl === 'string' && wasmUrl.startsWith('data:')) {
    let raw = null;
    try {
      const resp = await fetch(wasmUrl);
      if (resp.ok) {
        raw = new Uint8Array(await resp.arrayBuffer());
      }
    } catch {}
    if (!raw) {
      const comma = wasmUrl.indexOf(',');
      const b64 = wasmUrl.slice(comma + 1);
      const binStr = atob(b64);
      const len = binStr.length;
      raw = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        raw[i] = binStr.charCodeAt(i);
      }
    }
    // If gzipped (magic header 0x1f 0x8b), decompress via browser built-in DecompressionStream
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      if (typeof DecompressionStream !== 'undefined') {
        const ds = new DecompressionStream('gzip');
        const writer = ds.writable.getWriter();
        writer.write(raw);
        writer.close();
        const decompressed = await new Response(ds.readable).arrayBuffer();
        wasmBytes = new Uint8Array(decompressed);
        return wasmBytes;
      }
      throw new Error('Browser lacks DecompressionStream support for gzipped WASM');
    }
    wasmBytes = raw;
    return wasmBytes;
  }
  const resp = await fetch(wasmUrl);
  if (!resp.ok) {
    throw new Error('Failed to fetch cotilla.wasm: ' + resp.status);
  }
  const raw = new Uint8Array(await resp.arrayBuffer());
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const writer = ds.writable.getWriter();
      writer.write(raw);
      writer.close();
      const decompressed = await new Response(ds.readable).arrayBuffer();
      wasmBytes = new Uint8Array(decompressed);
      return wasmBytes;
    }
  }
  wasmBytes = raw;
  return wasmBytes;
}

async function bootstrap() {
  console.debug('[bootstrap] initializing WebAssembly core...');
  if (!wasmModule) {
    const bytes = await getWasmBytes();
    wasmModule = await WebAssembly.compile(bytes);
  }

  const go = new window.Go();
  const instance = await WebAssembly.instantiate(wasmModule, go.importObject);
  go.run(instance);

  while (!window.cotilla) {
    await new Promise((r) => setTimeout(r, 15));
  }

  console.debug('[bootstrap] initializing identity and distribution channel...');
  const cotillaConfig = {
    protocol: {
      maxPeers: 12,
      minPublicGroupPeers: 2,
      minPrivateGroupPeers: 6,
      initialBroadcastTTL: 1,
      initialBroadcastFanout: 2,
      publicGroupTTL: 6,
      privateGroupTTL: 3,
    },
    app: {
      appName: APP_ID,
      minSeq: 1,
      validSignatures: PINNED_PUB_KEY ? [PINNED_PUB_KEY] : [],
      seederGroup: {
        name: DIST_ROOM_ID,
        channel: CHANNEL,
      },
    },
  };
  const initRes = JSON.parse(window.cotilla.init({ protocol: cotillaConfig.protocol }));
  identity = { address: initRes.address, signPub: initRes.signPub };

  joinRes = JSON.parse(window.cotilla.bootstrapApp(cotillaConfig.app));

  window.cotilla.setOnAttachmentProgress((fileID, received, total) => {
    console.debug(`[bootstrap] chunk progress: ${received}/${total}`);
    if (progressBar) {
      progressBar.max = total;
      progressBar.value = received;
    }
  });

  window.cotilla.setOnAppManifest((manifestJSON, from) => {
    console.debug('[bootstrap] discovered manifest from seeder:', from);
  });

  window.cotilla.setOnOpen((addr) => {
    console.debug('[bootstrap] WebRTC peer open:', addr);
    if (window.cotilla.isGatewayPeer && window.cotilla.isGatewayPeer(addr)) {
      console.debug('[bootstrap] gateway peer open, querying peers:', addr);
      if (window.cotilla.addGatewayPeer) window.cotilla.addGatewayPeer(addr);
      if (window.cotilla.addPeer) window.cotilla.addPeer(addr);
      if (window.cotilla.queryPeers) window.cotilla.queryPeers();
      return;
    }
    if (window.cotilla.addPeer) {
      window.cotilla.addPeer(addr);
    }
    if (window.cotilla.requestAppManifest) {
      window.cotilla.requestAppManifest();
    }
  });

  if (window.cotilla.setOnPeerLeft) {
    window.cotilla.setOnPeerLeft((addr) => {
      console.debug('[bootstrap] peer left:', addr);
      if (!downloadedBundle && !ws) {
        setTimeout(connectSignaling, 2000);
      }
    });
  }

  window.cotilla.setOnAppBundleReady((manifestJSON, bundleU8) => {
    if (downloadedBundle) return;
    downloadedBundle = true;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }

    console.debug('[bootstrap] validating publisher signature & digest...');
    const verifyRes = JSON.parse(
      window.cotilla.verifyAppBundle(manifestJSON, bundleU8, PINNED_PUB_KEY, APP_ID, CHANNEL, 1)
    );

    if (verifyRes.error) {
      console.error('[bootstrap] bundle verification rejected:', verifyRes.error);
      downloadedBundle = false;
      return;
    }

    console.debug('[bootstrap] bundle verified. Launching application...');

    const preservedHash = window.location.hash;
    const parsedManifest = JSON.parse(manifestJSON);
    const bootSignalingUrl = resolveSignalingUrl();
    const decoder = new TextDecoder('utf-8');
    const appHtml = decoder.decode(bundleU8);

    // Defer shutdown and document replacement until after Go's syscall/js callback returns.
    setTimeout(() => {
      if (ws) {
        wsIntentionalClose = true;
        try {
          ws.close();
        } catch {}
        ws = null;
      }

      if (window.cotilla && window.cotilla.shutdown) {
        window.cotilla.shutdown();
      }

      window.__COTILLA_BOOTSTRAP__ = {
        version: 1,
        wasmBytes: wasmBytes,
        wasmModule: wasmModule,
        manifest: parsedManifest,
        bundleBytes: bundleU8,
        pinnedPubKeyHex: PINNED_PUB_KEY,
        distRoomID: DIST_ROOM_ID,
        distRoomKey: joinRes.room_key,
        signalingUrl: bootSignalingUrl,
        createSFrameWorker: () => new SFrameWorker(),
      };

      document.open();
      document.write(appHtml);
      document.close();

      if (window.location.hash !== preservedHash) {
        window.location.hash = preservedHash;
      }
    }, 0);
  });

  connectSignaling();
}

let wsIntentionalClose = false;

function connectSignaling() {
  if (downloadedBundle) return;

  const signalingUrl = resolveSignalingUrl();

  console.debug('[bootstrap] connecting signaling:', signalingUrl);
  wsIntentionalClose = false;
  ws = new WebSocket(signalingUrl);

  ws.onopen = () => {
    console.debug('[bootstrap] signaling connected, registering...');
    const regMsg = JSON.parse(window.cotilla.signSignaling('register', '', ''));
    ws.send(JSON.stringify(regMsg));

    if (!pollInterval) {
      pollInterval = setInterval(() => {
        if (downloadedBundle) {
          clearInterval(pollInterval);
          pollInterval = null;
          return;
        }
        if (window.cotilla && window.cotilla.queryPeers) {
          window.cotilla.queryPeers();
        }
        if (window.cotilla && window.cotilla.requestAppManifest) {
          window.cotilla.requestAppManifest();
        }
      }, 1500);
    }
  };

  ws.onmessage = async (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.error) {
      console.debug('[bootstrap] signaling error:', msg.error);
      return;
    }

    if (msg.type === 'offer') {
      if (window.cotilla.verifySignaling && !window.cotilla.verifySignaling(ev.data)) {
        console.debug('[bootstrap] dropped unverified offer from', msg.peer);
        return;
      }
      if (window.cotilla.addGatewayPeer) {
        window.cotilla.addGatewayPeer(msg.peer);
      }
      try {
        const answerSDP = await window.cotilla.acceptOffer(msg.peer, msg.sdp);
        if (answerSDP && !String(answerSDP).startsWith('error:')) {
          const answerMsg = JSON.parse(window.cotilla.signSignaling('answer', msg.peer, answerSDP));
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(answerMsg));
          }
        }
      } catch (err) {
        console.debug('[bootstrap] acceptOffer failed for', msg.peer, err);
      }
      return;
    }

    if (msg.type === 'ok') {
      console.debug('[bootstrap] signaling handshake complete, closing WS');
      wsIntentionalClose = true;
      try {
        ws.close();
      } catch {}
      ws = null;
      return;
    }
  };

  ws.onerror = (err) => {
    console.debug('[bootstrap] signaling socket error:', err);
  };

  ws.onclose = () => {
    const intentional = wsIntentionalClose;
    ws = null;
    if (!intentional && !downloadedBundle) {
      console.debug('[bootstrap] signaling closed, retrying in 2s...');
      setTimeout(connectSignaling, 2000);
    }
  };
}

bootstrap().catch((err) => {
  console.debug('[bootstrap] error:', err);
  setTimeout(bootstrap, 2000);
});
