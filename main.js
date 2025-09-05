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
    
    // استفاده از Environment Variables از Amplify
    AWS.config.credentials = new AWS.Credentials({
      accessKeyId: 'YOUR_ACCESS_KEY_HERE',
      secretAccessKey: 'YOUR_SECRET_KEY_HERE'
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
    pc.ontrack = (e) => { if (!remoteVideo.srcObject) remoteVideo.srcObject = e.streams[0]; };
    pc.onconnectionstatechange = () => log('PC state:', pc.connectionState);

    const signalingClient = new KVSWebRTC.SignalingClient({
      channelARN: channelArn,
      channelEndpoint: endpoints.WSS,
      clientId: 'viewer-' + Date.now(),
      role: KVSWebRTC.Role.VIEWER,
      region: REGION,
      credentials: AWS.config.credentials,
      systemClockOffset: kv.config.systemClockOffset
    });

    signalingClient.on('open', async () => {
      log('Signaling OPEN. Creating offer...');
      try {
        const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
        await pc.setLocalDescription(offer);
        log('Offer created and set as local description');
        signalingClient.sendSdpOffer(pc.localDescription);
        log('SDP offer sent to master');
      } catch (err) {
        log('Error creating offer:', err.message);
      }
    });

    signalingClient.on('sdpAnswer', async answer => { 
      log('Got SDP answer from master'); 
      await pc.setRemoteDescription(answer);
      log('Remote description set');
    });
    
    signalingClient.on('iceCandidate', cand => { 
      log('Remote ICE candidate received'); 
      pc.addIceCandidate(cand); 
    });
    
    signalingClient.on('error', (error) => {
      log('Signaling error:', error.message);
    });
    
    pc.onicecandidate = ({ candidate }) => { 
      if (candidate) {
        log('Sending local ICE candidate');
        signalingClient.sendIceCandidate(candidate);
      }
    };

    signalingClient.open();
    log('VIEWER started.');
  } catch (err) {
    console.error(err); log('ERROR:', err && (err.message || JSON.stringify(err)));
    alert('Error: ' + (err?.message || err));
  }
};