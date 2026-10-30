export class NotificationManager {
  static show(message: string, type: 'success' | 'error' = 'success') {
    const notification = document.createElement('div');
    notification.className = `notification notification--${type}`;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    // Trigger animation
    setTimeout(() => notification.classList.add('notification--show'), 100);
    
    // Remove after delay
    setTimeout(() => {
      notification.classList.add('notification--hide');
      setTimeout(() => {
        if (document.body.contains(notification)) {
          document.body.removeChild(notification);
        }
      }, 300);
    }, 5000);
  }
}

export function determineRecordType(key: string): 'metadata' | 'content' {
  const contentKeys = ['ipfs-root', 'content-hash', 'data-uri', 'ipfs', 'hash'];
  return contentKeys.some(ck => key.toLowerCase().includes(ck)) ? 'content' : 'metadata';
}

export function truncateValue(value: string, maxLength = 100): string {
  return value.length > maxLength ? value.substring(0, maxLength) + '...' : value;
}

export function validateEthereumAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export async function callWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Call timeout'));
    }, timeoutMs);

    promise
      .then(result => {
        clearTimeout(timeout);
        resolve(result);
      })
      .catch(error => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}