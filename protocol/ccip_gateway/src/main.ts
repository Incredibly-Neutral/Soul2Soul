import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import { ethers } from "ethers";

const app = express();
const PORT = process.env.PORT || 3000;

// Base RPC endpoints to try
const BASE_RPC_URLS = [
  process.env.BASE_RPC_URL || "https://mainnet.base.org",
  "https://base-rpc.publicnode.com",
  "https://base-mainnet.g.alchemy.com/v2/demo",
];


// Middleware
app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: false,
  }),
);

// CORS configuration for ENS domains
app.use(
  cors({
    origin: true,
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
    optionsSuccessStatus: 200
  }),
);

app.use(morgan("combined"));
app.use(express.json({ limit: "10mb" }));
app.use(express.text({ limit: "10mb" }));
app.use(express.raw({ type: "application/octet-stream", limit: "10mb" }));

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// CCIP-Read gateway endpoint
app.post("/", async (req, res) => {
  try {
    console.log("=== CCIP-Read Gateway Request ===");
    console.log("Content-Type:", req.headers["content-type"]);
    console.log("Body type:", typeof req.body);
    console.log("Body:", JSON.stringify(req.body));
    console.log("Body.data exists:", !!(req.body && req.body.data));
    console.log("Body.data value:", req.body && req.body.data);

    let callData: string;

    // Try to parse body if it's a string
    let bodyObj = req.body;
    if (typeof req.body === "string") {
      try {
        bodyObj = JSON.parse(req.body);
        console.log("Parsed string body as JSON:", bodyObj);
      } catch (e) {
        console.log("Body is string but not JSON:", req.body);
      }
    }

    // Handle different content types
    if (
      req.headers["content-type"]?.includes("application/json") ||
      (typeof bodyObj === "object" && bodyObj !== null && bodyObj.data)
    ) {
      // JSON format: { "data": "0x...", "sender": "0x..." }
      console.log("Processing JSON request");
      if (!bodyObj.data) {
        return res
          .status(400)
          .json({ error: "Missing data field in JSON request" });
      }
      callData = bodyObj.data;
      console.log("Sender:", bodyObj.sender || "not provided");
    } else if (Buffer.isBuffer(req.body)) {
      // Raw binary data
      console.log("Processing raw binary request");
      callData = "0x" + req.body.toString("hex");
    } else if (typeof req.body === "string") {
      // Raw hex string
      console.log("Processing hex string request");
      callData = req.body.startsWith("0x") ? req.body : "0x" + req.body;
    } else {
      console.log("Unknown request format:", typeof req.body, req.body);
      return res.status(400).json({ error: "Invalid request format" });
    }

    console.log("CallData:", callData);
    console.log("CallData length:", callData.length);

    // Validate callData
    if (!callData || callData.length < 10) {
      return res.status(400).json({ error: "Invalid callData length" });
    }

    // Decode the CCIP-Read call data
    // Format: abi.encode(baseRecordsContract, contractCallData)
    let decoded;
    try {
      decoded = ethers.AbiCoder.defaultAbiCoder().decode(
        ["address", "bytes"],
        callData,
      );
    } catch (decodeError: any) {
      console.error("Failed to decode callData:", decodeError.message);
      return res.status(400).json({
        error: "Failed to decode callData",
        details: decodeError.message,
      });
    }

    const baseRecordsContract = decoded[0] as string;
    const contractCallData = decoded[1] as string;

    console.log("Target contract:", baseRecordsContract);
    console.log("Contract call data:", contractCallData);

    // Decode the contract call to see what function is being called
    if (contractCallData.length >= 10) {
      const functionSelector = contractCallData.slice(0, 10);
      console.log("Function selector:", functionSelector);

      // Check if it's getText(bytes32,string) - selector 0xad428dac
      if (functionSelector === "0xad428dac") {
        try {
          const params = ethers.AbiCoder.defaultAbiCoder().decode(
            ["bytes32", "string"],
            "0x" + contractCallData.slice(10),
          );
          console.log("getText parameters:");
          console.log("  Node:", params[0]);
          console.log("  Key:", params[1]);
        } catch (e) {
          console.log("Could not decode getText parameters:", e);
        }
      }
    }

    // Try each Base RPC endpoint until one works
    let response: string | null = null;
    let lastError: Error | null = null;

    for (const rpcUrl of BASE_RPC_URLS) {
      try {
        console.log(`Trying RPC endpoint: ${rpcUrl}`);

        const provider = new ethers.JsonRpcProvider(rpcUrl);

        // Make the eth_call
        const result = await provider.call({
          to: baseRecordsContract,
          data: contractCallData,
        });

        console.log("RPC call successful!");
        console.log("Raw result:", result);

        response = result;
        break;
      } catch (error: any) {
        console.log(`RPC endpoint ${rpcUrl} failed:`, error.message);
        lastError = error;
        continue;
      }
    }

    if (response === null) {
      console.error(
        "All RPC endpoints failed. Last error:",
        lastError?.message,
      );
      return res.status(502).json({
        error: "All Base RPC endpoints failed",
        lastError: lastError?.message,
      });
    }

    // Return the response in the format expected by CCIP-Read clients
    console.log("Returning successful response");

    // Set CORS headers explicitly
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization",
    );
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Content-Type", "application/json");

    // Return the raw response data
    res.json({ data: response });
  } catch (error: any) {
    console.error("Gateway error:", error);
    res.status(500).json({
      error: "Gateway processing failed",
      message: error.message,
      stack: process.env.NODE_ENV === "development" ? error.stack : undefined,
    });
  }
});

// Handle CORS preflight requests
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.status(200).end();
});

// Catch-all for debugging
app.use("*", (req, res) => {
  console.log("Unhandled request:", req.method, req.originalUrl);
  console.log("Headers:", req.headers);
  console.log("Body:", req.body);
  res.status(404).json({ error: "Endpoint not found" });
});

// Error handling middleware
app.use(
  (
    error: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error("Unhandled error:", error);
    res.status(500).json({
      error: "Internal server error",
      message: error.message,
    });
  },
);

// Start server
app.listen(PORT, () => {
  console.log(`CCIP-Read Gateway running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Gateway endpoint: http://localhost:${PORT}/gateway`);
  console.log("Base RPC URLs:", BASE_RPC_URLS);
});

export default app;
