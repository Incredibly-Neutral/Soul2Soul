import * as fs from 'fs/promises';
import * as path from 'path';

export const clearFolder = async (folderPath: string) => {
    const files = await fs.readdir(folderPath);
    await Promise.all(
      files.map(async file => {
        const filePath = path.join(folderPath, file);
        const stat = await fs.lstat(filePath);
  
        if (stat.isDirectory()) {
          await fs.rm(filePath, { recursive: true, force: true });
        } else {
          await fs.unlink(filePath);
        }
      })
    );
  }