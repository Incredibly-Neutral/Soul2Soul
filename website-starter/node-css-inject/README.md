# Node CSS Inject

A TypeScript Node.js application that injects CSS directly into HTML files.

## Features

- Reads CSS files and combines them
- Injects combined CSS into HTML files' head section
- Processes multiple HTML files in batch
- TypeScript support for type safety
- Watch mode for development

## Installation

```bash
npm install
```

## Usage

1. Configure your CSS injection in `src/index.ts`:
   ```typescript
   const config: CSSInjectionConfig = {
       inputDir: '../output',           // Directory containing HTML files
       outputDir: '../output-with-css', // Directory for processed files
       cssFiles: ['styles.css']         // CSS files to inject
   };
   ```

2. Run the application:
   ```bash
   # Development mode (with auto-reload)
   npm run dev

   # Production mode
   npm run build
   npm start
   ```

## Development

- `npm run dev`: Runs the app in development mode with auto-reload
- `npm run build`: Compiles TypeScript to JavaScript
- `npm run watch`: Watches for changes and recompiles TypeScript
- `npm start`: Runs the compiled JavaScript
