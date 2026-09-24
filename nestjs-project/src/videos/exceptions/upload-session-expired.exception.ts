import { GoneException } from '@nestjs/common';

export class UploadSessionExpiredException extends GoneException {
  constructor() {
    super({
      statusCode: 410,
      error: 'UPLOAD_SESSION_EXPIRED',
      message: 'Sessão de upload não encontrada ou expirada.',
    });
  }
}
