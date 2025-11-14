declare module 'pdfkit' {
  export default class PDFDocument {
    y: number;
    constructor(options?: any);
    fontSize(size: number): PDFDocument;
    text(text: string, options?: any): PDFDocument;
    text(text: string, x: number, y: number, options?: any): PDFDocument;
    moveDown(lines?: number): PDFDocument;
    addPage(): PDFDocument;
    on(event: string, callback: (...args: any[]) => void): void;
    end(): void;
  }
}

