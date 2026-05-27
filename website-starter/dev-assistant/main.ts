import express, { Express, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import 'dotenv/config';
import { MainController } from './main.ctrlr';
import { clearFolder } from './fs';
import { downloadHTML } from './ipfs';

const app: Express = express();
const PORT = process.env.PORT || 3000;

function extractLogs(errorString: string): string[] {
  const jsonMatch = errorString.match(/Response from the nodes: ({.+})/s);
  
  if (!jsonMatch) return [];
  
  try {
    const errorData = JSON.parse(jsonMatch[1]);
    const logs = errorData.error?.logs || '';
    return logs.split('\n').filter((line: string) => line.trim().length > 0);
  } catch (e) {
    console.error('Failed to extract logs:', e);
    return [];
  }
}


const ctrlr = new MainController();
ctrlr.init()

// Middleware
app.use(helmet()); // Security headers
app.use(cors()); // Enable CORS
app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies

// Request logging middleware
app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});



// Routes
app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'Server is running' });
});

app.post('/', async (req: Request, res: Response) => {

    const STREAM_IDS = [
      "87119185787620437889240302547756526407722694952350143032371926081755117621597", // post
        // "64617781492805189701009480879149674604176067592032061274064038052630522871262",   // home
       // "40255038220314795022404003530460736335084480480965257555859155696237091809234" // page
    ];
    const publication = "block001.soul2soul.eth";
    const authorSafeAddress = "0x04660132323Fe65C5BaF9107Cfe8a941386b4EAF";
    
    const { config, cid: configCid } = await ctrlr.renewConfig(publication);

    try {

        const actions: any = await ctrlr.runAction(authorSafeAddress, publication, STREAM_IDS, configCid);

        console.log("actions", actions)
        const response = JSON.parse(actions.cbor);

        try { 

          if (response.cbor) {
            console.log("updatin local version ... ", response.cbor)
            const folder = "../html";
            clearFolder(folder);
            await downloadHTML(response.cbor, folder);
          }
        } catch( error) {
          console.log(error)
        }

        res.json({ cid: response.cbor});


    } catch(error: any) {

      console.log(error)
      const logs = extractLogs(error.message || error.toString());
    } 
});

app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});



// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

export default app;