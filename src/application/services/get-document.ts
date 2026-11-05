import type { DocumentRecord } from '../../domain/document.js';
import { DocumentNotFoundError } from '../../domain/errors.js';
import type { DocumentRepository } from '../ports/index.js';

export class GetDocumentService {
  constructor(private readonly repository: DocumentRepository) {}

  async execute(id: string): Promise<DocumentRecord> {
    const document = await this.repository.findById(id);
    if (!document) {
      throw new DocumentNotFoundError('Document not found', { documentId: id });
    }
    return document;
  }
}
