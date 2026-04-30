# CCIP-Read Gateway for ENS Resolver

A Node.js TypeScript service that acts as a CCIP-Read gateway for ENS resolvers, enabling them to fetch data from Base chain.

## Features

- Handles CCIP-Read requests from ENS UI and other clients
- Decodes ABI-encoded call data
- Makes RPC calls to Base chain
- Supports multiple Base RPC endpoints with failover
- Docker deployment ready
- Health check endpoint
- Comprehensive logging

## Quick Start

### Local Development

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start development server:**
   ```bash
   npm run dev
   ```

3. **Build for production:**
   ```bash
   npm run build
   npm start
   ```

### Docker Deployment

1. **Build the image:**
   ```bash
   docker build -t ccip-gateway .
   ```

2. **Run the container:**
   ```bash
   docker run -p 3000:3000 ccip-gateway
   ```

3. **With environment variables:**
   ```bash
   docker run -p 3000:3000 \
     -e BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_API_KEY \
     -e PORT=3000 \
     ccip-gateway
   ```

## Endpoints

### POST /gateway
Main CCIP-Read endpoint that:
- Accepts ABI-encoded call data
- Decodes the target contract and call data
- Makes RPC call to Base chain
- Returns the result

**Request formats supported:**
- JSON: `{ "data": "0x...", "sender": "0x..." }`
- Raw binary data
- Hex string

### GET /health
Health check endpoint that returns service status.

## Environment Variables

- `PORT` - Port to run the service on (default: 3000)
- `BASE_RPC_URL` - Primary Base RPC endpoint
- `NODE_ENV` - Environment (development/production)

## Usage with ENS Resolver

Update your resolver contract's `rpcUrls` to point to your deployed gateway:

```solidity
string[] memory urls = new string[](1);
urls[0] = "https://your-domain.com/gateway";
```

## Deployment Options

### Railway
```bash
# Connect your repo to Railway and deploy
railway up
```

### Heroku
```bash
heroku create your-ccip-gateway
git push heroku main
```

### AWS/GCP/Azure
Use the provided Dockerfile with your preferred container service.

## Testing

Test the gateway with curl:

```bash
curl -X POST http://localhost:3000/gateway \
  -H "Content-Type: application/json" \
  -d '{"data":"0x0000000000000000000000005d42f9b016b4251fc6407d5e8154da887f394900..."}'
```

## Logs

The service provides detailed logging of:
- Incoming requests and their format
- Call data decoding
- RPC endpoint attempts
- Successful responses
- Error conditions

## Security

- Runs as non-root user in Docker
- Helmet.js for security headers
- CORS enabled for cross-origin requests
- Request size limits
- Health checks enabled
