import { ConflictException } from '@nestjs/common';

export class UploadNotCompletedException extends ConflictException {
  constructor() {
    super({
      statusCode: 409,
      error: 'UPLOAD_NOT_COMPLETED',
      message: 'O upload do vídeo ainda não foi concluído.',
    });
  }
}
