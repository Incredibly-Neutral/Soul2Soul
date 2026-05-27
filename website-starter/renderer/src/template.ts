// Simple template system for Lit Actions
export function template(str: string, data: any): string {
    return str.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
        const value = key.trim().split('.').reduce((obj: any, k: string) => obj?.[k], data);
        return value !== undefined ? value : match;
    });
}

// Helper functions
export const helpers = {
    eq: (a: any, b: any) => a === b,
    not: (a: any) => !a,
    and: (...args: any[]) => args.slice(0, -1).every(Boolean),
    or: (...args: any[]) => args.slice(0, -1).some(Boolean),
    // Add more helpers as needed
};
