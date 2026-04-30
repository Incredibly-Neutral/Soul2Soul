import { helpers } from "./handlebars-helpers";
import { decode } from "html-entities";

interface TemplateData {
  [key: string]: any;
}

interface Partial {
  path: string;
  cid: string;
}

// Get value from templateData using dot notation and array access
const getNestedValue = (path: string, data: TemplateData): any => {
  if (!data) return undefined;

  // Handle array access with dot notation: path.to.[0].property
  const parts = path.split(".");
  const result = parts.reduce((obj, key) => {
    if (!obj) return undefined;

    // Handle array index access: [0]
    if (key.startsWith("[") && key.endsWith("]")) {
      const index = parseInt(key.slice(1, -1));
      return Array.isArray(obj) ? obj[index] : undefined;
    }

    return obj[key];
  }, data);

  return result;
};

// Get value from context, handling special variables and this
const getContextValue = (path: string, context: TemplateData): any => {
  const trimmedPath = path.trim();

  // Handle special variables
  if (trimmedPath === "@root") return context;
  if (
    trimmedPath === "@first" ||
    trimmedPath === "@last" ||
    trimmedPath === "@index"
  ) {
    return context[trimmedPath];
  }

  // Handle this keyword
  if (trimmedPath === "this") {
    return context.this || context;
  }

  // Handle parent context traversal (../)
  if (trimmedPath.startsWith("../")) {
    let currentContext = context;
    let remainingPath = trimmedPath;
    
    // Count how many levels up we need to go
    while (remainingPath.startsWith("../")) {
      remainingPath = remainingPath.slice(3); // Remove "../"
      if (currentContext.parentContext) {
        currentContext = currentContext.parentContext;
      } else {
        // If no parent context available, return undefined
        return undefined;
      }
    }
    
    // Now resolve the remaining path in the parent context
    if (remainingPath === "") {
      return currentContext;
    } else {
      return getContextValue(remainingPath, currentContext);
    }
  }

  // Check direct property access first
  if (context.hasOwnProperty(trimmedPath)) {
    return context[trimmedPath];
  }

  // Try getting from this first if it exists
  if (context.this && typeof context.this === "object") {
    const fromThis = getNestedValue(trimmedPath, context.this);
    if (fromThis !== undefined) {
      return fromThis;
    }
  }

  // Fall back to root context
  return getNestedValue(trimmedPath, context);
};

// Process variables in the template
const processVariables = (text: string, context: TemplateData): string => {
  if (!text.includes("{{")) return text;

  let result = text;

  // Handle triple braces first (unescaped HTML)
  const triplePattern = /{{{([^}]+)}}}/g;
  result = result.replace(triplePattern, (match, path) => {
    const value = getContextValue(path.trim(), context);
    return value !== undefined ? String(value) : "";
  });

  // Then handle double braces (escaped)
  const doublePattern = /{{([^#/>][^}]*)}}/g;
  result = result.replace(doublePattern, (match, path) => {
    const value = getContextValue(path.trim(), context);
    return value !== undefined ? escapeHtml(String(value)) : "";
  });

  return result;
};

// Process block helpers like {{#if}}, {{#each}}, etc.
const processBlockHelpers = (text: string, context: TemplateData): string => {
  // Skip if no block helpers
  if (!text.includes("{{#")) return text;

  let result = text;
  let changed = true;

  // Process all block types in document order to handle dependencies correctly
  let iteration = 0;
  while (changed) {
    iteration++;
    changed = false;
    const beforeLength = result.length;

    // Find all blocks and process them in document order
    const blocks = findAllBlocks(result);
    
    for (const block of blocks) {
      const oldResult = result;
      
      if (block.type === 'if') {
        result = processIfBlocks(result, context);
      } else if (block.type === 'with') {
        result = processWithBlocks(result, context);
      } else if (block.type === 'each') {
        result = processEachBlocks(result, context);
      }
      
      // If this block was processed, break and start over to maintain correct order
      if (result !== oldResult) {
        changed = true;
        break;
      }
    }

    // If no individual block processing happened, try all blocks once more
    if (!changed) {
      result = processIfBlocks(result, context);
      result = processWithBlocks(result, context);
      result = processEachBlocks(result, context);
      
      if (result.length !== beforeLength) {
        changed = true;
      }
    }


  }

  return result;
};

// Find all block helpers in document order
const findAllBlocks = (text: string): Array<{type: string, position: number}> => {
  const blocks: Array<{type: string, position: number}> = [];
  
  // Find all block opening tags
  const blockRegex = /{{#(if|with|each)\s/g;
  let match;
  
  while ((match = blockRegex.exec(text)) !== null) {
    blocks.push({
      type: match[1],
      position: match.index
    });
  }
  
  // Sort by position (document order)
  return blocks.sort((a, b) => a.position - b.position);
};

// Process nested if blocks properly
const processIfBlocks = (text: string, context: TemplateData): string => {
  let result = text;
  let processedAny = false;
    const regex = /{{#if\s+([^}]+)}}/g;
    let match;

    while ((match = regex.exec(result)) !== null) {
      const startPos = match.index;
      const condition = match[1].trim();

      // Find the matching {{/if}} by counting nested blocks
      let depth = 1;
      let pos = match.index + match[0].length;
      let endPos = -1;
      let elsePos = -1;

      while (pos < result.length && depth > 0) {
        const remainingText = result.substring(pos);
        const openMatch = remainingText.match(/{{#if\s/);
        const closeMatch = remainingText.match(/{{\/if}}/);
        const elseMatch = remainingText.match(/{{else}}/);

        let nextOpen = openMatch
          ? pos + remainingText.indexOf(openMatch[0])
          : Infinity;
        let nextClose = closeMatch
          ? pos + remainingText.indexOf(closeMatch[0])
          : Infinity;
        let nextElse =
          elseMatch && depth === 1 && elsePos === -1
            ? pos + remainingText.indexOf(elseMatch[0])
            : Infinity;

        if (nextElse < nextOpen && nextElse < nextClose) {
          elsePos = nextElse;
          pos = nextElse + 8; // length of "{{else}}"
        } else if (nextClose < nextOpen) {
          depth--;
          if (depth === 0) {
            endPos = nextClose;
            break;
          }
          pos = nextClose + 7; // length of "{{/if}}"
        } else if (nextOpen < Infinity) {
          depth++;
          pos = nextOpen + 5; // length of "{{#if"
        } else {
          break;
        }
      }

      if (endPos !== -1) {
        const contentStart = startPos + match[0].length;
        const content =
          elsePos !== -1
            ? result.substring(contentStart, elsePos)
            : result.substring(contentStart, endPos);
        const elseContent =
          elsePos !== -1 ? result.substring(elsePos + 8, endPos) : "";
        const fullMatch = result.substring(startPos, endPos + 7);

        try {
          // Handle eq helper in if blocks
          if (condition.startsWith("(eq ")) {
            const argsStr = condition.slice(4, -1).trim();
            const args = argsStr.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];

            if (args.length === 2) {
              const [arg1, arg2] = args;
              const val1 = arg1.startsWith('"')
                ? arg1.slice(1, -1)
                : arg1.startsWith("'")
                  ? arg1.slice(1, -1)
                  : getContextValue(arg1, context);
              const val2 = arg2.startsWith('"')
                ? arg2.slice(1, -1)
                : arg2.startsWith("'")
                  ? arg2.slice(1, -1)
                  : getContextValue(arg2, context);

              // Create context with parent reference for nested blocks
              const ifContext = { ...context, parentContext: context };
              const processedContent =
                val1 === val2
                  ? processTemplate(content, ifContext)
                  : elseContent
                    ? processTemplate(elseContent, ifContext)
                    : "";
              result = result.replace(fullMatch, processedContent);
            }
          } else {
            // Handle regular conditions
            const value = getContextValue(condition, context);
            // Create context with parent reference for nested blocks
            const ifContext = { ...context, parentContext: context };
            const processedContent = value
              ? processTemplate(content, ifContext)
              : elseContent
                ? processTemplate(elseContent, ifContext)
                : "";
            result = result.replace(fullMatch, processedContent);
          }

          processedAny = true;
          break;
        } catch (error) {
          console.error("Error in if block:", error);
          result = result.replace(fullMatch, "");
          processedAny = true;
          break;
        }
      }
    }
  
  return result;
};

// Process nested each blocks properly
const processEachBlocks = (text: string, context: TemplateData): string => {
  let result = text;
  let processedAny = false;
    const regex =
      /{{#each\s+([^}]*?)(?=\s+as\s+|}})\s*(?:as\s+\|([^|]+)\|)?\s*}}/g;
    let match;

    while ((match = regex.exec(result)) !== null) {
      const startPos = match.index;
      const arrayPath = match[1].trim();
      const alias = match[2];
      

      
      // Find the matching {{/each}} by counting nested blocks
      let depth = 1;
      let pos = match.index + match[0].length;
      let endPos = -1;

      while (pos < result.length && depth > 0) {
        const remainingText = result.substring(pos);
        const openMatch = remainingText.match(/{{#each\s/);
        const closeMatch = remainingText.match(/{{\/each}}/);

        let nextOpen = openMatch
          ? pos + remainingText.indexOf(openMatch[0])
          : Infinity;
        let nextClose = closeMatch
          ? pos + remainingText.indexOf(closeMatch[0])
          : Infinity;

        if (nextClose < nextOpen) {
          depth--;
          if (depth === 0) {
            endPos = nextClose;
            break;
          }
          pos = nextClose + 9; // length of "{{/each}}"
        } else if (nextOpen < Infinity) {
          depth++;
          pos = nextOpen + 7; // length of "{{#each"
        } else {
          break;
        }
      }

      if (endPos !== -1) {
        const content = result.substring(startPos + match[0].length, endPos);
        const fullMatch = result.substring(startPos, endPos + 9);

        try {
          const array = getContextValue(arrayPath, context);
          if (!Array.isArray(array)) {
            console.error(
              "Each block array not found or not an array:",
              arrayPath,
            );
            result = result.replace(fullMatch, "");
          } else {
            const processedContent = array
              .map((item, index) => {
                // Create a context with special variables while preserving parent context
                const itemContext = {
                  ...context, // Keep parent context
                  "@index": index,
                  "@first": index === 0,
                  "@last": index === array.length - 1,
                  "@key": arrayPath.split(".").pop() || "",
                  parentContext: context, // Preserve parent context reference
                };

                if (alias) {
                  // If alias is provided, set the item under that name
                  itemContext[alias] = item;
                  // Keep this as the item for backward compatibility
                  itemContext.this = item;

                } else {
                  // No alias - use original behavior
                  itemContext.this = item;
                  // Only spread item properties if item is an object (not primitive)
                  if (
                    typeof item === "object" &&
                    item !== null &&
                    !Array.isArray(item)
                  ) {
                    Object.assign(itemContext, item);
                    itemContext.this = item; // Ensure this stays as the item
                  }
                }

                return processTemplate(content, itemContext);
              })
              .join("");

            result = result.replace(fullMatch, processedContent);
          }

          processedAny = true;
          break;
        } catch (error) {
          console.error("Error in each block:", error);
          result = result.replace(fullMatch, "");
          processedAny = true;
          break;
        }
      }
    }
  
  return result;
};

// Process nested with blocks properly
const processWithBlocks = (text: string, context: TemplateData): string => {
  let result = text;
  let processedAny = false;
    const regex =
      /{{#with\s+([^}]*?)(?=\s+as\s+|}})\s*(?:as\s+\|([^|]+)\|)?\s*}}/g;
    let match;

    while ((match = regex.exec(result)) !== null) {
      const startPos = match.index;
      const expression = match[1].trim();
      const alias = match[2];
      


      // Find the matching {{/with}} by counting nested blocks
      let depth = 1;
      let pos = match.index + match[0].length;
      let endPos = -1;

      while (pos < result.length && depth > 0) {
        const remainingText = result.substring(pos);
        const openMatch = remainingText.match(/{{#with\s/);
        const closeMatch = remainingText.match(/{{\/with}}/);

        let nextOpen = openMatch
          ? pos + remainingText.indexOf(openMatch[0])
          : Infinity;
        let nextClose = closeMatch
          ? pos + remainingText.indexOf(closeMatch[0])
          : Infinity;

        if (nextClose < nextOpen) {
          depth--;
          if (depth === 0) {
            endPos = nextClose;
            break;
          }
          pos = nextClose + 9; // length of "{{/with}}"
        } else if (nextOpen < Infinity) {
          depth++;
          pos = nextOpen + 6; // length of "{{#with"
        } else {
          break;
        }
      }

      if (endPos !== -1) {
        const content = result.substring(startPos + match[0].length, endPos);
        const fullMatch = result.substring(startPos, endPos + 9);

        // Process the with block
        try {
          let value;

          if (expression.includes(" ")) {
            const [helperName, ...args] = expression.split(" ").map(part => part.trim());
            const helper = helperMap.get(helperName);
            
            if (helper) {
              const resolvedArgs = args.map((arg, index) => {
                let resolved;
                if (arg.startsWith('"') && arg.endsWith('"')) {
                  resolved = arg.slice(1, -1);
                } else if (arg.startsWith("'") && arg.endsWith("'")) {
                  resolved = arg.slice(1, -1);
                } else {
                  resolved = getContextValue(arg, context);
                }
                

                return resolved;
              });
              

              
              value = helper(...resolvedArgs);
            } else {
              value = getContextValue(expression, context);
            }
          } else {
            value = getContextValue(expression, context);
          }

          if (value === undefined || value === null) {
            result = result.replace(fullMatch, "");
          } else {
            const withContext = { ...context };
            if (alias) {
              withContext[alias] = value;
            } else {
              if (typeof value === "object" && !Array.isArray(value)) {
                Object.assign(withContext, value);
              } else {
                withContext.this = value;
              }
            }

            // Preserve parent context reference for path traversal
            withContext.parentContext = context;

            const processedContent = processTemplate(content, withContext);
            result = result.replace(fullMatch, processedContent);
          }

          processedAny = true;
          break;
        } catch (error) {
          console.error("Error in with block:", error);
          result = result.replace(fullMatch, "");
          processedAny = true;
          break;
        }
      }
    }
  
  return result;
};

// Create a map of helpers for faster lookup
const helperMap = new Map(helpers.map((h) => [h.name, h.helper]));

// Process helpers in the template
const processHelpers = (text: string, context: TemplateData): string => {
  // Match both double and triple braces
  const helperRegex = /{{{?\s*(\w+)\s+([^}]+)}}}?/g;
  return text.replace(helperRegex, (match, helperName, args) => {
    // Skip block helpers and partials
    if (match.startsWith("{{#") || match.startsWith("{{>")) {
      return match;
    }

    const helper = helperMap.get(helperName);
    if (!helper) return match;

    try {
      // Split args and resolve context values
      const resolvedArgs = args.split(" ").map((arg) => {
        const trimmed = arg.trim();
        if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
          return trimmed.slice(1, -1);
        }
        if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
          return trimmed.slice(1, -1);
        }
        return getContextValue(trimmed, context);
      });

      // Call the helper with resolved arguments
      const result = helper(...resolvedArgs);
      return result !== undefined ? String(result) : "";
    } catch (error) {
      console.error(`Error processing helper ${helperName}:`, error);
      return "";
    }
  });
};

export const processTemplate = (
  text: string,
  context: TemplateData,
): string => {
  if (!text) return "";

  // Process in specific order: blocks first, then helpers, then variables
  let result = text;
  result = processBlockHelpers(result, context);
  result = processHelpers(result, context);
  result = processVariables(result, context);
  return result;
};

export const cleanTemplateString = (content: string): string => {
  if (!content) return "";
  return decode(content)
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/^"/, "") // Remove leading quote
    .replace(/"$/, "") // Remove trailing quote
    .replace(/(?<=>)"\s*/g, "") // Remove quotes and spaces after >
    .replace(/\s*"(?=<)/g, "") // Remove quotes and spaces before <
    .trim();
};

export const processPartials = async (
  template: string,
  partials: Partial[],
  templateData: TemplateData,
): Promise<string> => {
  // First fetch and clean all partials
  const processedPartials: { [key: string]: string } = {};

  for (const partial of partials) {
    try {
      const response = await fetch(
        `https://ipfs.transport-union.dev/api/v0/cat?arg=${partial.cid}`,
        {
          method: "POST",
        },
      );

      if (!response.ok) continue;

      let content = await response.text();
      content = cleanTemplateString(content);

      // Get filename without path or extension
      const name = partial.path
        .substring(partial.path.lastIndexOf("/") + 1)
        .split(".")[0];
      processedPartials[name] = content;
    } catch (error) {
      continue;
    }
  }

  // Then recursively replace partials in template
  let html = template;
  let depth = 0;
  let changed = true;

  while (changed && depth < 10) {
    // Max 10 levels of nesting
    changed = false;
    for (const [name, content] of Object.entries(processedPartials)) {
      const regex = new RegExp(`{{\\s*>\\s*${name}\\s*}}`, "g");
      if (regex.test(html)) {
        // Clean the content again after replacing to handle any nested quotes
        html = html.replace(regex, content);
        changed = true;
      }
    }
    depth++;
    // Clean any quotes that might have been introduced
    html = cleanTemplateString(html);
  }

  // Process the complete template after all partials are inserted
  return processTemplate(html, templateData);
};

// HTML escape function
const escapeHtml = (str: string): string => {
  const htmlEscapes: { [key: string]: string } = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return str.replace(/[&<>"']/g, (char) => htmlEscapes[char]);
};
