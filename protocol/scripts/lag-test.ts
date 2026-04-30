import * as ethers from 'ethers';
const CID = require('cids');

// Convert contenthash hex to CID string
function contenthashToCID(hexString: string): string | null {
  if (!hexString || !hexString.startsWith('0x')) return null;
  
  try {
    const hex = hexString.slice(2);
    
    // Check for ipfs-ns (e3) and cidv1 (01)
    if (hex.slice(0, 4) !== 'e301') {
      console.log('Not a CIDv1 contenthash');
      return null;
    }
    
    // Skip e301, reconstruct CID bytes
    // Format: version (01) + codec (70 = dag-pb) + multihash
    const cidHex = '01' + '70' + hex.slice(4);
    const cidBytes = Buffer.from(cidHex, 'hex');
    
    // Parse CID from bytes
    const cid = new CID(cidBytes);
    
    return cid.toString();
  } catch (error: any) {
    console.error('Error decoding contenthash:', error.message);
    return null;
  }
}

async function checkGatewayResolution() {
  try {
    const response = await fetch('https://block001.soul2soul.eth.link/', { 
      method: 'HEAD', 
      cache: 'no-cache' 
    });
    
    const ipfsPath = response.headers.get('x-ipfs-path');
    return ipfsPath ? ipfsPath.split('/')[2] : null;
  } catch (error: any) {
    console.error('Gateway error:', error.message);
    return null;
  }
}

async function checkCIDOnChain() {
  try {
    const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
    const node = ethers.namehash('block001.soul2soul.eth');
    
    const contract = new ethers.Contract(
      '0x5D42f9b016B4251FC6407d5e8154DA887F394900',
      ['function getText(bytes32 node, string key) view returns (string)'],
      provider
    );
    
    const contenthashHex = await contract.getText(node, 'contenthash_wrapped');
    const cid = contenthashToCID(contenthashHex);
    
    return cid;
  } catch (error: any) {
    console.error('On-chain error:', error.message);
    return null;
  }
}

async function monitor() {
  const timestamp = new Date().toLocaleTimeString();
  
  const [gatewayCID, onchainCID] = await Promise.all([
    checkGatewayResolution(),
    checkCIDOnChain()
  ]);
  
  console.log(`\n[${timestamp}] === Checking ENS Resolution ===`);
  console.log(`  Gateway:  ${gatewayCID || 'null'}`);
  console.log(`  On-chain: ${onchainCID || 'null'}`);
  
  if (gatewayCID && onchainCID) {
    const match = gatewayCID === onchainCID;
    console.log(`  Match:    ${match ? '✅ SYNCED' : '❌ OUT OF SYNC'}`);
    
    if (!match) {
      console.log(`  ⏱️  Gateway serving old content`);
    }
  }
  console.log('==========================================');
}

console.log('🚀 Starting ENS CID comparison monitor...\n');
monitor();
const checkInterval = setInterval(monitor, 5000);

console.log('Monitoring every 5 seconds. Press Ctrl+C to stop.\n');