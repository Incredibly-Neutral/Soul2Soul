// s2s-records-tab.ts
import { ConfigBuilder } from '@/lib/config-builder.js';
import { SafeIntegration } from '../lib/safe-integration.js';
import { S2SRecord } from '../types/index.js';
import { ProtocolIntegration } from '../lib/protocol-integration.js';


export class S2SRecordsTab extends HTMLElement {
  public safeIntegration!: SafeIntegration;
  public protocolIntegration!: ProtocolIntegration;
  private records: S2SRecord[] = [];
  private filteredRecords: S2SRecord[] = [];
  private loading = true;
  private searchTerm = '';
  private editingKey: string | null = null;

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  async connectedCallback() {
    console.log('Records tab connected');
    await this.loadRecords();
    this.render();
  }

  private async loadRecords() {
    this.loading = true;
    this.render();

    try {
      const [keys, values] = await this.safeIntegration.getAllRecords();
      
      this.records = keys.map((key: string, index: number) => ({
        key,
        value: values[index],
        type: this.determineRecordType(key) as 'metadata' | 'content'
      }));
      
      this.filteredRecords = [...this.records];
      console.log('Records loaded:', this.records);
    } catch (error) {
      console.error('Error loading records:', error);
    }

    this.loading = false;
    this.render();
  }

  private determineRecordType(key: string): 'metadata' | 'content' {
    const contentKeys = ['ipfs-root', 'content-hash', 'data-uri', 'ipfs', 'hash', 'cid'];
    return contentKeys.some(ck => key.toLowerCase().includes(ck)) ? 'content' : 'metadata';
  }

  private filterRecords() {
    this.filteredRecords = this.records.filter(record =>
      record.key.toLowerCase().includes(this.searchTerm.toLowerCase()) ||
      record.value.toLowerCase().includes(this.searchTerm.toLowerCase())
    );
    this.render();
  }

  private async addRecord(key: string, value: string) {
    if (!key.trim() || !value.trim()) {
      this.showNotification('Key and value cannot be empty', 'error');
      return;
    }

    if (this.records.some(r => r.key === key)) {
      this.showNotification('Key already exists', 'error');
      return;
    }

    try {
      await this.safeIntegration.setRecord(key, value);
      this.showNotification('Record added! Transaction pending approval.', 'success');
      
      // Optimistically update
      const newRecord: S2SRecord = { 
        key, 
        value, 
        type: this.determineRecordType(key) as 'metadata' | 'content' 
      };
      this.records.push(newRecord);
      this.filterRecords();
    } catch (error) {
      console.error('Error adding record:', error);
      this.showNotification('Failed to add record. Please try again.', 'error');
    }
  }

  private async updateRecord(key: string, newValue: string) {
    const recordIndex = this.records.findIndex(r => r.key === key);
    if (recordIndex === -1) return;

    try {
      await this.safeIntegration.setRecord(key, newValue);
      this.showNotification('Record updated! Transaction pending approval.', 'success');
      
      // Optimistically update
      this.records[recordIndex].value = newValue;
      this.editingKey = null;
      this.filterRecords();
    } catch (error) {
      console.error('Error updating record:', error);
      this.showNotification('Failed to update record. Please try again.', 'error');
    }
  }

  private async deleteRecord(key: string) {
    if (!confirm(`Delete record "${key}"?`)) {
      return;
    }

    const recordIndex = this.records.findIndex(r => r.key === key);
    if (recordIndex === -1) return;

    try {
      await this.safeIntegration.deleteRecord(key);
      this.showNotification('Record deleted! Transaction pending approval.', 'success');
      
      // Optimistically update
      this.records.splice(recordIndex, 1);
      this.filterRecords();
    } catch (error) {
      console.error('Error deleting record:', error);
      this.showNotification('Failed to delete record. Please try again.', 'error');
    }
  }

  private startEdit(key: string) {
    this.editingKey = key;
    this.render();
  }

  private cancelEdit() {
    this.editingKey = null;
    this.render();
  }

  private async updateConfig() {


    // const service = new ProtocolInfoService(this.safeIntegration, "https://ipfs.transport-union.dev");
    // const protocolInfo = await service.getProtocolInfo();



    const existingCid = await this.safeIntegration.getRecord('config');
    const repo = await this.safeIntegration.getRecord('repo');
    const publicationUrl = await this.safeIntegration.getRecord('name');
    const pInfo = await this.protocolIntegration.getInfo();
  

    const builder = new ConfigBuilder(
          pInfo.ensRecords,
          'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySW5mb3JtYXRpb24iOnsiaWQiOiI0MzNhYjNkMS02YTZjLTQzMGUtODhkZC03Yzc0Y2MyZmQzMDkiLCJlbWFpbCI6ImpvZXJhQGpvZXJhbXVsZGVycy5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZSwicGluX3BvbGljeSI6eyJyZWdpb25zIjpbeyJkZXNpcmVkUmVwbGljYXRpb25Db3VudCI6MSwiaWQiOiJOWUMxIn1dLCJ2ZXJzaW9uIjoxfSwibWZhX2VuYWJsZWQiOmZhbHNlLCJzdGF0dXMiOiJBQ1RJVkUifSwiYXV0aGVudGljYXRpb25UeXBlIjoic2NvcGVkS2V5Iiwic2NvcGVkS2V5S2V5IjoiNDdlMTk2ZDI2ODNjMzNhMWJmNDUiLCJzY29wZWRLZXlTZWNyZXQiOiI4MjE0NDY0YTAyOTlmMmE1OGU4MzcwNWI4NWYxNTNjMTQ1Mzc2YWY3ODc1N2ZjOWI5NTM3YjBjNWFiZGQyNWY0IiwiZXhwIjoxNzc1MDU1NTAyfQ.PnFMDGxYGbzfqFjcENNgSEi393Pi5qE0ebZPOBEJUVk',
          'https://neutralpress.mypinata.cloud',
          'https://ipfs.transport-union.dev',
        );

    const { cid } = await builder.buildConfig(
      repo.split("/")[3],
      repo.split("/")[4],
      "main",
      // commit,
      publicationUrl,
      this.safeIntegration.getSafeInfo().s2sPublication || "",
      existingCid
    );

    console.log("this really is the new cid:", cid)

    // Update config record in Safe
    // await this.safeIntegration.setRecord('config', cid);

    // const executionUrl = await this.safeIntegration.setRecord('config', cid);
    // window.open(executionUrl, '_blank')
    
    
    // Show a modal or notification with the link
    // alert({
    //   title: 'Transaction Proposed',
    //   message: 'Please execute the transaction in Safe',
    //   action: {
    //     label: 'Execute in Safe',
    //     onClick: () => window.open(executionUrl, '_blank')
    //   }
    // });

  }

  private showNotification(message: string, type: 'success' | 'error') {
    const notification = document.createElement('div');
    notification.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      padding: 16px 24px;
      border-radius: 8px;
      color: white;
      font-weight: 500;
      z-index: 1000;
      max-width: 400px;
      background: ${type === 'success' ? '#10b981' : '#ef4444'};
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    `;
    
    notification.textContent = message;
    document.body.appendChild(notification);
    
    setTimeout(() => {
      if (document.body.contains(notification)) {
        document.body.removeChild(notification);
      }
    }, 5000);
  }

  private render() {
    if (!this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          padding: 2rem 0;
        }

        .section {
          margin-bottom: 2rem;
        }

        .section-title {
          font-size: 1.5rem;
          font-weight: 600;
          color: #000;
          margin: 0 0 1rem 0;
          display: flex;
          align-items: center;
          gap: 0.75rem;
        }

        .section-description {
          color: #000;
          margin-bottom: 1.5rem;
        }

        .search-input {
          width: 100%;
          padding: 0.75rem 1rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 1rem;
          margin-bottom: 2rem;
          box-sizing: border-box;
          transition: border-color 0.2s, box-shadow 0.2s;
        }

        .search-input:focus {
          outline: none;
          border-color: #5bba9d;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .add-form {
          display: grid;
          grid-template-columns: 1fr 2fr auto;
          gap: 1rem;
          background: #f9fafb;
          padding: 1.5rem;
          border-radius: 0.5rem;
          border: 1px solid #e5e7eb;
          margin-bottom: 2rem;
        }

        @media (max-width: 768px) {
          .add-form {
            grid-template-columns: 1fr;
          }
        }

        .input {
          padding: 0.75rem 1rem;
          border: 1px solid #d1d5db;
          border-radius: 0.5rem;
          font-size: 1rem;
          transition: border-color 0.2s, box-shadow 0.2s;
        }

        .input:focus {
          outline: none;
          border-color: #5bba9d;
          box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
        }

        .button {
          background: #5bba9d;
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 0.5rem;
          cursor: pointer;
          font-size: 1rem;
          font-weight: 500;
          transition: background-color 0.2s, transform 0.1s;
          white-space: nowrap;
        }

        .button:hover {
          background: #5bba9d;
          transform: translateY(-1px);
        }

        .button:active {
          transform: translateY(0);
        }

        .button-secondary {
          background: #6b7280;
        }

        .button-secondary:hover {
          background: #4b5563;
        }

        .button-danger {
          background: #ef4444;
        }

        .button-danger:hover {
          background: #dc2626;
        }

        .button-small {
          padding: 0.5rem 1rem;
          font-size: 0.875rem;
        }

        .records-list {
          display: grid;
          gap: 1rem;
        }

        .record-card {
          background: #f9fafb;
          border: 1px solid #e5e7eb;
          border-radius: 0.5rem;
          padding: 1.5rem;
        }

        .record-header {
          display: flex;
          justify-content: space-between;
          align-items: start;
          margin-bottom: 1rem;
        }

        .record-key {
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 0.875rem;
          font-weight: 600;
          color: #111827;
          word-break: break-word;
        }

        .record-type-badge {
          display: inline-block;
          padding: 0.25rem 0.75rem;
          border-radius: 9999px;
          font-size: 0.75rem;
          font-weight: 500;
          margin-left: 0.5rem;
        }

        .type-content {
          background: #dbeafe;
          color: #1e40af;
        }

        .type-metadata {
          background: #fce7f3;
          color: #9f1239;
        }

        .record-value {
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 0.875rem;
          color: #374151;
          word-break: break-all;
          line-height: 1.5;
          margin-bottom: 1rem;
        }

        .record-value-input {
          width: 100%;
          font-family: 'Monaco', 'Menlo', monospace;
          font-size: 0.875rem;
          padding: 0.75rem;
          border: 1px solid #d1d5db;
          border-radius: 0.375rem;
          margin-bottom: 1rem;
          box-sizing: border-box;
        }

        .record-actions {
          display: flex;
          gap: 0.5rem;
        }

        .record-count {
          background: #3b82f6;
          color: white;
          padding: 0.25rem 0.75rem;
          border-radius: 9999px;
          font-size: 0.875rem;
          font-weight: 500;
        }

        .empty-state {
          text-align: center;
          padding: 3rem;
          color: #6b7280;
        }

        .empty-icon {
          font-size: 3rem;
          margin-bottom: 1rem;
        }

        .loading {
          text-align: center;
          padding: 3rem;
          color: #6b7280;
        }
      </style>

      ${this.loading ? `
        <div class="loading">
          <p>Loading records...</p>
        </div>
      ` : `
        <!-- Search -->
        <div class="section">
          <input 
            type="text" 
            class="search-input" 
            placeholder="🔍 Search records by key or value..."
            id="search-input"
            value="${this.searchTerm}"
          />
        </div>

        <!-- Add Record -->
        <div class="section">
            <button class="button" data-action="update">Update</button>
        </div>
        <div class="section">
          <h2 class="section-title">➕ Add New Record</h2>
          <p class="section-description">Store configuration and metadata for your publication</p>
          
          <div class="add-form">
            <input 
              type="text" 
              class="input" 
              placeholder="Key (e.g., title, author, ipfs-hash)"
              id="new-key"
            />
            <input 
              type="text" 
              class="input" 
              placeholder="Value"
              id="new-value"
            />
            <button class="button" id="add-btn">
              ➕ Add Record
            </button>
          </div>
        </div>

        <!-- Records List -->
        <div class="section">
          <h2 class="section-title">
            📋 Records 
            <span class="record-count">${this.filteredRecords.length}</span>
          </h2>
          
          ${this.filteredRecords.length > 0 ? `
            <div class="records-list">
              ${this.filteredRecords.map(record => `
                <div class="record-card">
                  <div class="record-header">
                    <div>
                      <span class="record-key">${record.key}</span>
                      <span class="record-type-badge type-${record.type}">
                        ${record.type === 'content' ? '📦 Content' : '📝 Metadata'}
                      </span>
                    </div>
                  </div>
                  
                  ${this.editingKey === record.key ? `
                    <input 
                      type="text" 
                      class="record-value-input" 
                      value="${record.value}"
                      id="edit-value-${record.key}"
                    />
                    <div class="record-actions">
                      <button 
                        class="button button-small"
                        data-action="save"
                        data-key="${record.key}"
                      >
                        ✓ Save
                      </button>
                      <button 
                        class="button button-secondary button-small"
                        data-action="cancel"
                      >
                        ✗ Cancel
                      </button>
                    </div>
                  ` : `
                    <div class="record-value">${record.value}</div>
                    <div class="record-actions">
                      <button 
                        class="button button-secondary button-small"
                        data-action="edit"
                        data-key="${record.key}"
                      >
                        ✏️ Edit
                      </button>
                      <button 
                        class="button button-danger button-small"
                        data-action="delete"
                        data-key="${record.key}"
                      >
                        🗑️ Delete
                      </button>
                    </div>
                  `}
                </div>
              `).join('')}
            </div>
          ` : `
            <div class="empty-state">
              <div class="empty-icon">📄</div>
              <p>${this.searchTerm ? 'No records match your search' : 'No records yet'}</p>
            </div>
          `}
        </div>
      `}
    `;

    if (!this.loading) {
      this.attachEventListeners();
    }
  }

  private attachEventListeners() {
    // Search
    const searchInput = this.shadowRoot?.querySelector('#search-input') as HTMLInputElement;
    searchInput?.addEventListener('input', (e) => {
      this.searchTerm = (e.target as HTMLInputElement).value;
      this.filterRecords();
    });

    // Add record
    const addBtn = this.shadowRoot?.querySelector('#add-btn');
    const newKeyInput = this.shadowRoot?.querySelector('#new-key') as HTMLInputElement;
    const newValueInput = this.shadowRoot?.querySelector('#new-value') as HTMLInputElement;

    const handleAdd = () => {
      const key = newKeyInput?.value.trim();
      const value = newValueInput?.value.trim();
      
      if (key && value) {
        this.addRecord(key, value).then(() => {
          newKeyInput.value = '';
          newValueInput.value = '';
        });
      }
    };

    addBtn?.addEventListener('click', handleAdd);
    
    [newKeyInput, newValueInput].forEach(input => {
      input?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          handleAdd();
        }
      });
    });

    // Record actions
    this.shadowRoot?.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const target = e.currentTarget as HTMLButtonElement;
        const action = target.dataset.action;
        const key = target.dataset.key;
        
        if (action === 'edit' && key) {
          this.startEdit(key);
        } else if (action === 'delete' && key) {
          this.deleteRecord(key);
        } else if (action === 'save' && key) {
          const input = this.shadowRoot?.querySelector(`#edit-value-${key}`) as HTMLInputElement;
          if (input) {
            this.updateRecord(key, input.value);
          }
        } else if (action === 'cancel') {
          this.cancelEdit();
        } else if (action === 'update') {
          this.updateConfig();
        }
      });
    });
  }
}

customElements.define('s2s-records-tab', S2SRecordsTab);