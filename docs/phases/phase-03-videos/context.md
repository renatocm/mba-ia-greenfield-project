---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-09-23T13:59:53-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-09-23T15:35:52-03:00"
  docs/phases/phase-02-auth/context.md: "2026-09-23T13:59:53-03:00"
  docs/phases/phase-02-auth/phase-02-auth.md: "2026-09-23T13:59:53-03:00"
  docs/diagrams/software-arch.mermaid: "2026-09-23T13:59:53-03:00"
  CLAUDE.md: "2026-09-23T13:59:53-03:00"
  nestjs-project/CLAUDE.md: "2026-09-23T13:59:53-03:00"
  .claude/rules/nestjs-modules.md: "2026-09-23T13:59:53-03:00"
  .claude/rules/nestjs-controllers.md: "2026-09-23T13:59:53-03:00"
  .claude/rules/nestjs-services.md: "2026-09-23T13:59:53-03:00"
  .claude/rules/nestjs-testing.md: "2026-09-23T13:59:53-03:00"
  .claude/rules/nestjs-common-conventions.md: "2026-09-23T13:59:53-03:00"
  .claude/rules/nestjs-layer-separation.md: "2026-09-23T13:59:53-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Objective:** viabilizar upload de arquivos grandes sem travar a API, persistir o vídeo como draft desde o início, processar mídia em background e disponibilizar reprodução/download a partir de URLs únicas.

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** frontend/upload UI, edição de metadados do vídeo, fluxo rascunho → publicação, visibilidade public/unlisted, player frontend, comentários/likes/inscrições, adaptive streaming (HLS/DASH), transcoding multi-bitrate e observabilidade avançada além do necessário para o pipeline.

**Deliverables:** upload de até 10GB funcional via object storage S3-compatible, criação de draft no início do upload, processamento assíncrono com worker separado, extração de metadados, thumbnail default, streaming por Range/206, download via URL assinada e `publicId` único por vídeo.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — fora do escopo desta phase; apenas o contrato backend fica consolidado aqui.

**Sequencing notes:** Depends on Fase 01, Fase 02.

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Notes |
|-----|--------|-------|-------|--------|----------|-------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | BullMQ sobre Redis | Biblioteca e configuração consolidadas em `library-refs.md` |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Large File Upload Strategy | decided | Presigned multipart upload direto ao storage | Fluxo multipart canônico e URLs de 1h documentados em `library-refs.md` |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Session Orchestration and Draft Creation | decided | Criar draft antes de emitir sessão multipart | Cleanup de drafts órfãos fixado em 24 horas |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Processing Worker Architecture | decided | Worker dedicado em container/processo separado | Configuração operacional consolidada nesta phase |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Metadata Extraction and Thumbnail Generation Policy | decided | `ffprobe` para metadados + thumbnail em percentual da duração | Metadados persistem mesmo se thumbnail falhar |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | S3-Compatible Object Storage Organization | decided | Buckets separados por responsabilidade (`videos-originals`, `videos-public`) | `videos-originals` é privado para vídeos; `videos-public` é apenas para thumbnails |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Cross-layer | Public Video URL Identifier Strategy | decided | `publicId` curto, opaco e imutável | Geração com `nanoid` documentada em `library-refs.md` |
| phase-03-videos/TD-08 | technical-decisions-phase-03-videos.md | Cross-layer | Streaming Delivery Strategy | decided | HTTP Range / `206 Partial Content` direto do storage | URL assinada de 30 minutos no bucket privado |
| phase-03-videos/TD-09 | technical-decisions-phase-03-videos.md | Cross-layer | Download Delivery Strategy | decided | API autoriza e devolve URL assinada de download | URL assinada de 24 horas com `Content-Disposition` |
| phase-03-videos/TD-10 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle and Recovery Model | decided | Status público enxuto + detalhes internos na tabela `videos` | Trilha completa por logs estruturados; sem tabela separada de tentativas |
| phase-03-videos/TD-11 | technical-decisions-phase-03-videos.md | Backend | Queue Messages and Event Contracts | decided | Comando `video.process.requested` via BullMQ | `jobId=video-${videoId}` + worker idempotente por status |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-06 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-04, phase-03-videos/TD-11 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-03, phase-03-videos/TD-10 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-10, phase-03-videos/TD-11 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05, phase-03-videos/TD-10 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-07 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-08 |
| Download do vídeo pelo usuário | phase-03-videos/TD-09 |

## Architecture Overview

### Diagram Reference

Ver `docs/diagrams/software-arch.mermaid`:

- **API** (`Nest.js`) — regras de negócio, autenticação, criação de drafts, assinatura de URLs, publicação de jobs
- **Video Worker** (`FFmpeg`) — processa mídia em background
- **Object Storage** (`S3 or MinIO`) — armazena vídeos e thumbnails
- **Message Queue** (`TBD` no diagrama; decidido como BullMQ sobre Redis nesta phase)
- **Database** (`PostgreSQL`) — persiste usuários, canais, vídeos e estado do pipeline

### Domain Integration

#### From Phase 02 (Auth / Users / Channels)

- **User entity:** já existe como identidade autenticada do dono do vídeo; ownership e autorização partem do `user.id`
- **Channel entity:** já existe e representa a identidade pública do produtor; vídeos pertencem a um canal já cadastrado
- **JWT auth:** autenticação e guards já foram estabelecidos na Fase 02; endpoints de upload/gerenciamento continuam protegidos por padrão
- **Validation + exception filters:** `ValidationPipe` global e envelope padronizado `{ statusCode, error, message }` já existem e devem ser reutilizados

#### Within Phase 03

- **Video draft:** nasce antes do upload com `publicId` imutável e status inicial `draft`
- **Upload session:** coordena multipart upload direto ao storage sem a API trafegar o binário
- **Video metadata:** duração, resolução, codec, bitrate, fps e demais campos extraídos pelo worker
- **Thumbnail default:** artefato derivado do vídeo, gerado pelo worker e salvo em bucket de leitura pública
- **Processing attempts:** trilha operacional para retries, falhas permanentes e recuperação

### Interaction Flow (High-Level)

1. Usuário autenticado inicia upload
   → API valida ownership/canal
   → API cria `Video` em `draft` com `publicId`
   → API abre sessão multipart no storage
   → API devolve URLs assinadas por parte

2. Cliente envia as partes diretamente ao object storage
   → binário não passa pela API

3. Cliente conclui o multipart upload
   → API confirma a sessão
   → persiste metadados básicos da sessão
   → publica `video.process.requested`

4. Worker consome o job
   → lê o original do storage
   → extrai metadados com `ffprobe`
   → gera thumbnail com FFmpeg
   → salva thumbnail no storage
   → atualiza status do vídeo para `ready`

5. Em caso de falha
   → BullMQ realiza retries com backoff
   → última falha é persistida
   → se `ffprobe` nunca concluir com sucesso, vídeo vai para `error`
   → se apenas a thumbnail falhar após metadados persistidos, o vídeo pode ir para `ready` sem thumbnail e a UI usa placeholder

6. Reprodução ou download
   → API valida acesso
   → API devolve URL assinada
   → storage responde ao stream com `Range`/`206` ou entrega download com `Content-Disposition`

## Implementation Constraints

### From Architecture (C4 + technical decisions)

- Worker é **container/processo separado** da API; não deve compartilhar o mesmo runtime da aplicação HTTP
- Object storage é **S3-compatible**: MinIO em dev/local, S3 em produção
- Fila é **BullMQ sobre Redis**
- API **não faz proxy** do binário nem no upload, nem no streaming, nem no download

### From Existing Code (Phase 02)

- `User` e `Channel` já existem e são pré-requisitos para ownership/autorização
- JWT guard global já está em vigor; endpoints públicos precisam `@Public()` explícito
- Exception filters e `ValidationPipe` globais já padronizam erro/validação
- Separação de camadas já está estabelecida: controller fino, regra de negócio em service, filtros/guards delegando a services

### From CLAUDE.md

- **Single Responsibility:** API, worker, queue e storage devem manter responsabilidades separadas
- **Type Safety:** TypeScript estrito em todas as camadas; contratos da fila, DTOs e entidades precisam ser tipados
- **Testing Pyramid:** unit > integration > e2e, usando o sufixo correto para cada teste
- **Definition of Done:** testes relevantes + suíte completa + `tsc --noEmit` + `npm run lint`

### From Docker / NestJS Conventions

- Sempre usar **nomes dos serviços Docker**, nunca `localhost`, para integrações entre containers
- `DB_HOST=db`
- Todos os comandos Node/Nest/testes rodam **dentro do container** `nestjs-api`
- Variáveis `.env` com caracteres especiais devem ser **quoted**

### Phase 03 Specific Configuration

These are Phase 03 implementation details, not project-wide conventions. Each environment (dev, staging, prod) configures these accordingly.

- `REDIS_URL`
  - dev local: `redis://redis:6379`
  - produção: via variável de ambiente do ambiente alvo
- `S3_ENDPOINT`
  - MinIO local: `http://minio:9000`
  - AWS S3: `https://s3.amazonaws.com` (ou endpoint regional equivalente)
- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `S3_BUCKET_ORIGINALS`
  - default: `videos-originals`
- `S3_BUCKET_PUBLIC`
  - default: `videos-public`

### From Module / Controller / Service / Testing Rules

- Cada feature deve morar no seu próprio módulo NestJS com `TypeOrmModule.forFeature([...])` no módulo dono das entidades
- Controllers seguem REST, documentação OpenAPI e permanecem finos
- Services não engolem erros; exceções de domínio sobem para filtros
- Guards/filtros/pipes/interceptors não carregam regra de negócio diretamente
- Testes seguem a convenção:
  - `.spec.ts` = unit, sem DB/I/O externo
  - `.integration-spec.ts` = integração com DB real
  - `.e2e-spec.ts` = fluxo HTTP completo em `test/`
- Integração/e2e devem rodar com `--runInBand`

## Key Dependencies & External Integrations

### Phase 02 dependencies reused

- `User` + `Channel` como base de ownership
- JWT access token + auth guards para proteger endpoints
- DTO validation e error envelope já consolidados

### New integrations in Phase 03

- **Redis**
  - papel: broker da BullMQ
  - host Docker: `redis`
  - env: `REDIS_URL=redis://redis:6379`

- **Object Storage (MinIO/S3)**
  - papel: uploads multipart, armazenamento privado de vídeos e armazenamento público de thumbnails
  - host Docker local: `minio`
  - envs da phase:
    - `S3_ENDPOINT`
    - `AWS_ACCESS_KEY_ID`
    - `AWS_SECRET_ACCESS_KEY`
    - `S3_BUCKET_ORIGINALS=videos-originals`
    - `S3_BUCKET_PUBLIC=videos-public`
  - organização decidida:
    - `videos-originals` (privado) — originais MP4 em `{publicId}/original.mp4`; streaming e download sempre via URL assinada
    - `videos-public` (public-read) — thumbnails em `{publicId}/{publicId}_default.jpg`
  - cleanup: sessões multipart incompletas são auto-abortadas após 1 dia via lifecycle do bucket; drafts órfãos são auditáveis por `draft_created_at` + 24h

- **Video Worker**
  - papel: consumir `video.process.requested`
  - dependências funcionais: BullMQ, TypeORM, SDK S3-compatible, FFmpeg/ffprobe
  - acessos: Database + Storage + Redis

### Signed URL Expiration Policy

| Operação | Expiração | Uso |
|----------|-----------|-----|
| CreateMultipartUpload / UploadPart presigned URLs | 1 hora (`3600s`) | tempo para subir todas as partes e repetir partes com falha |
| Streaming (`GET` com `Range`) | 30 minutos (`1800s`) | sessão típica de reprodução |
| Download | 24 horas (`86400s`) | janela suficiente para baixar arquivos grandes |

### Library references resolved

- `@nestjs/bullmq` + `bullmq` — integração NestJS 11 + fila Redis
- `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` — multipart, lifecycle e URLs assinadas
- `nanoid` — geração de `publicId`
- FFmpeg/ffprobe — binários do container do worker

## Technical Specifications — Outline

### API endpoints expected in this phase

Endpoints listed below are design proposals for Phase 03. Final API contract will be documented in the plan-build phase specification.

**Design convention note:** Sub-resource paths follow `.claude/rules/nestjs-controllers.md` (e.g., `/channels/{channelId}/videos` for channel-scoped sub-resources).

- `POST /videos/upload-session` — inicia draft + sessão multipart
- `POST /videos/upload-session/complete` — conclui upload e publica job
- `GET /videos/{publicId}` — retorna metadados do vídeo
- `GET /videos/{publicId}/stream` — devolve URL assinada para reprodução
- `GET /videos/{publicId}/download` — devolve URL assinada para download
- `GET /channels/{channelId}/videos` — lista vídeos do canal (sub-resource pattern per `.claude/rules/nestjs-controllers.md`)

### Worker processing outline

**Worker configuration**

| Item | Valor |
|------|-------|
| Queue name | `video-processing` |
| Job name | `process-video` |
| Attempts | `5` |
| Backoff | `exponential` com `delay: 2000ms` |
| Concurrency | `2` |

Concurrency can be adjusted based on worker resource availability and video processing load.

**Payload base**
- `eventId`
- `videoId`
- `publicId`
- `ownerUserId`
- `sourceBucket`
- `sourceObjectKey`
- `storageProvider`
- `uploadSessionId`
- `attempt`

**Idempotência canônica**
- enqueue dedup: BullMQ usa `jobId = video-${videoId}`
- novo enqueue com o mesmo `jobId` não cria processamento paralelo independente
- antes de trabalho pesado, o worker consulta `video.status`
- se `status = 'ready'`, o job é ignorado
- se `status = 'processing'`, nenhuma nova execução independente é iniciada; retries do mesmo job BullMQ continuam o processamento canônico
- `status = 'error'` permite retry manual/automático
- `status = 'draft'` ainda não processa até `complete multipart upload`

**Falha parcial e recuperação**
- o worker consulta `video.status` antes de iniciar processamento pesado
- metadados e thumbnail são tratados em etapas desacopladas
- se `ffprobe` falhar, nenhum metadado é persistido e o vídeo vai para `error`
- se `ffprobe` tiver sucesso e a geração de thumbnail falhar, os metadados são persistidos imediatamente
- retries subsequentes pulam `ffprobe` quando `metadata_json` já for válido e tentam apenas a thumbnail
- se a thumbnail falhar nas 5 tentativas, o vídeo transita para `ready` sem thumbnail; a UI deve mostrar placeholder quando `thumbnail_url` estiver nulo
- `last_error`, `last_error_at` e `last_error_stack_trace` registram a última falha; o histórico detalhado de tentativas fica em logs estruturados

### Database schema additions (outline)

- **`videos`**
  - `status` (`draft | processing | ready | error`)
  - `public_id` (unique, immutable)
  - `processing_attempts` (`integer`, default `0`)
  - `last_error` (`text`, nullable)
  - `last_error_at` (`timestamp`, nullable)
  - `last_error_stack_trace` (`text`, nullable)
  - `draft_created_at`
  - `upload_session_id`
  - `upload_completed_at`
  - `processing_started_at`
  - `processing_completed_at`
  - `metadata_json`

### Migrations expected

- adicionar colunas e índices na tabela `videos`
- criar índices em `videos.public_id`, `videos.channel_id`, `videos.status`
- não criar tabela separada de `processing_attempts`; a auditoria detalhada fica em logs estruturados

## Definition of Done (Phase 03)

Per `CLAUDE.md`, uma mudança desta phase só está pronta quando:

1. **Relevant test suite passes**
   - unit tests para services/utilitários/DTOs
   - integration tests para entidades, repositórios e módulos com DB real
   - e2e tests para fluxo HTTP principal
   - comandos executados no container

2. **Full test suite passes**
   - sem regressão da Fase 02

3. **TypeScript compiles cleanly**
   - `docker compose exec nestjs-api npx tsc --noEmit`

4. **Lint passes**
   - `docker compose exec nestjs-api npm run lint`

## Risks, Gaps & Assumptions

### Assumptions

- endpoints de upload e gestão de vídeos exigem usuário autenticado
- ownership do vídeo decorre do vínculo usuário → canal
- object storage S3-compatible oferece multipart presigned upload e `Range`/`206` suficientes para esta fase
- upload de 10GB é viável via multipart sem a API intermediar o binário
- cleanup de uploads órfãos usa a combinação de lifecycle nativo do S3/MinIO (multipart incompleto) + auditoria opcional no banco para drafts sem conclusão há 24h

### Remaining implementation-detail gaps

- CORS exato dos buckets e shape final das respostas HTTP serão detalhados no plan-build
- políticas operacionais de provisionamento (Docker Compose, IaC, secrets management) serão materializadas na fase de implementação
- contratos de DTO/OpenAPI finais ainda serão formalizados quando a especificação da API for escrita

### Potential risks

- falhas transitórias em multipart upload exigem boa política de retentativa por parte no cliente
- vídeos que cheguem a `ready` sem thumbnail dependem de placeholder consistente na UI
- FFmpeg pode ser intensivo em CPU/memória; a concorrência inicial de `2` deve ser reavaliada conforme carga real
- streaming e download dependem de buckets privados corretamente configurados com URLs assinadas

### Library & Dependency Status

**Resolved for this phase**

- `@nestjs/bullmq` / `bullmq` para filas e worker processing
- `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` para storage S3-compatible
- FFmpeg/ffprobe como binários no container do worker
- `nanoid` para geração de `publicId`
- `REDIS_URL`, `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_ORIGINALS` e `S3_BUCKET_PUBLIC` definidos como configuração específica da phase

## Validation Checklist

- [ ] Todas as capabilities da Fase 03 estão mapeadas para pelo menos uma TD
- [ ] Não há contradições entre Phase 03 e pressupostos herdados da Fase 02
- [ ] TDs cross-layer (`TD-02`, `TD-03`, `TD-07`, `TD-08`, `TD-09`) permanecem compatíveis com contrato futuro de frontend, sem exigir frontend agora
- [ ] Lifecycle do vídeo (`draft → processing → ready | error`) está explicitado
- [ ] Fluxo multipart presigned cobre iniciar, enviar partes, concluir e cleanup/abort
- [ ] Isolamento do worker está explícito (container separado, sem proxy da API)
- [ ] Estratégia de idempotência está registrada para validação posterior
- [ ] Definition of Done é executável com as convenções atuais do repositório
