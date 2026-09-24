import { NotFoundException } from '@nestjs/common';

export class VideoNotFoundException extends NotFoundException {
  constructor() {
    super({
      statusCode: 404,
      error: 'VIDEO_NOT_FOUND',
      message: 'Vídeo não encontrado.',
    });
  }
}
