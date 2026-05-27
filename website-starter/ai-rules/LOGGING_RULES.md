# Logging Rules for Objects Containing Posts

## Overview

When debugging Handlebars helpers or any code that deals with post objects, always use the `logObjectWithPosts()` utility function instead of directly logging objects that contain posts arrays. This prevents console logs from being flooded with huge amounts of post data.

## The Problem

Post objects contain large amounts of data including:
- Full HTML content
- Long stream IDs
- Metadata
- Multiple duplicate posts

Direct logging of these objects creates unreadable debug output that makes it difficult to trace issues.

## The Solution

Use the `logObjectWithPosts()` utility function that automatically truncates post data to show only essential fields:
- `title`
- `creation_date` 
- `stream_id` (truncated to first 20 characters + "...")

## Usage Examples

### ❌ DON'T DO THIS:
```javascript
console.log("posts data:", posts);
console.log("context with posts:", context);
```

### ✅ DO THIS INSTEAD:
```javascript
logObjectWithPosts("posts data:", posts);
logObjectWithPosts("context with posts:", context);
```

## Function Behavior

The `logObjectWithPosts()` function handles three cases:

1. **Array of posts**: Maps each post to show only essential fields
2. **Object with posts property**: Spreads the object but truncates the posts array
3. **Other data**: Logs normally without modification

## Implementation

The utility function is available in:
- `soul2soul/website-unamore/renderer/src/handlebars-helpers.ts` (source)
- `soul2soul/website-unamore/renderer/dist/main.js` (compiled)

## When to Use

Apply this rule whenever logging:
- Post arrays directly
- Context objects that may contain posts
- Function arguments that include posts
- Return values from helpers that process posts
- Any object where posts might be nested

## Examples in Codebase

Current implementations:
- `filter_by_year` helper uses this for logging posts arguments
- Template rendering debug statements use this for context logging

## Benefits

- **Readable logs**: Only essential post data is shown
- **Faster debugging**: No need to scroll through massive objects
- **Consistent logging**: Standardized approach across the codebase
- **Performance**: Reduced console output overhead