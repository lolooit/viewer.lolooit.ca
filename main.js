const logEl = document.getElementById('log');
const log = (...args) => { console.log(...args); logEl.textContent += args.join(' ') + '\n'; };

const cfg = window.APP_CONFIG;
document.getElementById('region').value = cfg.REGION;
document.getElementById('identityPool').value = cfg.IDENTITY_POOL_ID;

document.getElementById('startBtn').onclick = async () => {
  try {
    const REGION = document.getElementById('region').value.trim();
    const CHANNEL = cfg.CHANNEL_NAME;

    log('Init AWS...');
    AWS.config.region = REGION;
    
    // استفاده از Environment Variables
    AWS.config.credentials = new AWS.Credentials({
      accessKeyId: window.ENV?.ACCESS_KEY || 'YOUR_ACCESS_KEY',
      secretAccessKey: window.ENV?.SECRET_KEY || 'YOUR_SECRET_KEY'
    });
    log('AWS credentials ready.');

    const kv = new AWS.KinesisVideo({ region: REGION, credentials: AWS.config.credentials });

    log('DescribeSignalingChannel...');
    const { ChannelInfo } = await kv.describeSignalingChannel({ ChannelName: CHANNEL }).promise();
    const channelArn = ChannelInfo.ChannelARN;

    log('GetSignalingChannelEndpoint (VIEWER)...');
    const { ResourceEndpointList } = await kv.getSignalingChannelEndpoint({
      ChannelARN: channelArn,
      SingleMasterChannelEndpointConfiguration: { Protocols: ['WSS','HTTPS'], Role: 'VIEWER' }
    }).promise();

    const endpoints = {};
    (ResourceEndpointList || []).forEach(e => endpoints[e.Protocol] = e.ResourceEndpoint);

    const kvsSig = new AWS.KinesisVideoSignalingChannels({
      region: REGION, endpoint: endpoints.HTTPS, credentials: AWS.config.credentials
    });

    log('GetIceServerConfig...');
    const ice = await kvsSig.getIceServerConfig({ ChannelARN: channelArn }).promise();
    const iceServers = [{ urls: `stun:stun.kinesisvideo.${REGION}.amazonaws.com:443` }];
    (ice.IceServerList || []).forEach(s => iceServers.push({ urls: s.Uris, username: s.Username, credential: s.Password }));

    const pc = new RTCPeerConnection({ iceServers });
    const remoteVideo = document.getElementById('remoteVideo');
    pc.ontrack = (event) => { 
      log('Received remote video track');
      if (event.streams && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        log('Video stream attached to video element');
        // اطمینان از پخش ویدیو
        remoteVideo.play().catch(e => log('Video play error:', e.message));
      }
    };
    pc.onconnectionstatechange = () => {
      log('PC state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        log('✅ WebRTC connection established!');
      } else if (pc.connectionState === 'failed') {
        log('❌ WebRTC connection failed');
      }
    };

    const signalingClient = new KVSWebRTC.SignalingClient({
      channelARN: channelArn,
      channelEndpoint: endpoints.WSS,
      clientId: 'viewer-' + Date.now(),
      role: KVSWebRTC.Role.VIEWER,
      region: REGION,
      credentials: AWS.config.credentials,
      systemClockOffset: kv.config.systemClockOffset
    });

    // Event handlers
    signalingClient.on('open', async () => {
      log('Signaling OPEN. Creating offer...');
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        signalingClient.sendSdpOffer(pc.localDescription);
        log('SDP offer sent to master');
      } catch (err) {
        log('Error creating offer:', err.message);
      }
    });

    signalingClient.on('sdpAnswer', async (answer) => {
      log('Got SDP answer from master');
      try {
        await pc.setRemoteDescription(answer);
        log('Remote description set successfully');
      } catch (err) {
        log('Error setting remote description:', err.message);
      }
    });
    
    // Debug all signaling events
    ['iceCandidate', 'error', 'close', 'message'].forEach(event => {
      log('Registering handler for:', event);
    });
    
    signalingClient.on('iceCandidate', async (candidate) => { 
      log('Remote ICE candidate received'); 
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        log('Error adding ICE candidate:', err.message);
      }
    });
    
    signalingClient.on('error', (error) => {
      log('Signaling error:', error.message);
    });
    
    signalingClient.on('close', () => {
      log('Signaling connection closed');
    });
    
    pc.onicecandidate = ({ candidate }) => { 
      if (candidate) {
        log('Sending local ICE candidate');
        signalingClient.sendIceCandidate(candidate);
      }
    };

    signalingClient.on('message', (msg) => {
      log('Raw message received:', msg.messageType || 'unknown');
    });
    
    signalingClient.open();
    log('VIEWER started.');
    
    // Debug signaling client state
    setTimeout(() => {
      log('Signaling client state:', signalingClient.readyState);
    }, 1000);
  } catch (err) {
    console.error(err); log('ERROR:', err && (err.message || JSON.stringify(err)));
    alert('Error: ' + (err?.message || err));
  }
};