---
kind: technical-decisions
name: phase-03-videos
scope_type: phase
related_phases: [3]
covers_capabilities:
  - "Serviço de armazenamento de arquivos (vídeos e thumbnails)"
  - "Serviço de processamento em segundo plano (filas)"
  - "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"
  - "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"
  - "Processamento automático do vídeo após upload (extração de duração e metadados)"
  - "Geração automática de thumbnail a partir de um frame do vídeo"
  - "URL única por vídeo, sem conflito com outros vídeos"
  - "Reprodução via streaming (sem necessidade de download completo)"
  - "Download do vídeo pelo usuário"
status: decided
date: 2026-09-23
scope_description: "Decisões técnicas para upload direto ao object storage, processamento assíncrono com worker separado, organização S3-compatible, streaming/range requests, download e ciclo de status de vídeos."
---

# Technical Decisions — Phase 03: Upload & Video Processing

_Subprojects in scope:_

- `nestjs-project/` — backend responsável por criar o draft, negociar uploads diretos, publicar jobs, assinar URLs e persistir status/processamento.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O processamento de vídeo é pesado, precisa sair do request/response da API e exige persistência de jobs, retries controlados, deduplicação e trilha de falhas para reprocessamento.

**Options:**

### Option A: BullMQ sobre Redis
- Fila orientada a jobs, muito aderente ao ecossistema Node/NestJS, com suporte nativo a retries, backoff, concorrência por worker e `jobId` determinístico para idempotência.
- **Pros:** curva menor para NestJS; ergonomia boa para jobs assíncronos; persistência simples no Redis; retries e backoff de primeira classe; facilita um único tipo de worker de mídia.
- **Cons:** DLQ não é um primitivo tão forte quanto em brokers AMQP; exige Redis na stack; sem ordenação global forte.

### Option B: RabbitMQ com consumers NestJS
- Broker AMQP com ack/nack, exchanges, routing keys e dead-letter exchange nativa.
- **Pros:** DLQ madura; semântica de entrega explícita; bom isolamento entre tipos de mensagem.
- **Cons:** maior custo operacional; mais plumbing para retries exponenciais e deduplicação por vídeo.

### Option C: Amazon SQS
- Fila gerenciada na nuvem com visibilidade, DLQ e alta durabilidade.
- **Pros:** operação quase zero em produção; DLQ nativa; boa durabilidade.
- **Cons:** local dev fica assimétrico; integração NestJS menos idiomática; dependência de AWS desde já.

**Recommendation:** **BullMQ sobre Redis**.

**Recommended Decision:** Adoptar BullMQ como fila de processamento de vídeos, com Redis como broker de persistência e a seguinte configuração operacional inicial:

- queue name: `video-processing`
- job name: `process-video`
- attempts: `5`
- backoff: `exponential` com `delay: 2000ms`
- concurrency: `2` por instância de worker

**Rationale:**
- BullMQ é idiomático no ecossistema NestJS 11 via `@nestjs/bullmq`.
- `jobId` determinístico simplifica idempotência de enqueue.
- Redis é operacionalmente mais simples que AMQP/RabbitMQ para a fase atual.
- A concorrência inicial de `2` limita contenção de CPU/memória do FFmpeg sem impedir paralelismo.

**Consequences / Implications:**
- Exige Redis como serviço adicional em `docker-compose.yaml`.
- O worker consome da fila BullMQ e atualiza status/metadados do vídeo no DB.
- Falhas transitórias disparam retries automáticos; falhas permanentes atualizam colunas de erro na tabela `videos`.
- A biblioteca escolhida está consolidada em `docs/phases/phase-03-videos/library-refs.md` (`@nestjs/bullmq` + `bullmq`).

**Decision:** ✅ **Decidida** — BullMQ sobre Redis com configuração operacional inicial definida.

## TD-02: Large File Upload Strategy

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** O arquivo não deve trafegar pela API. O protocolo escolhido precisa suportar 10GB, falhas parciais de rede, retry por parte e retomada do upload sem reiniciar tudo.

**Options:**

### Option A: Upload multipart tradicional via API
- O cliente envia o arquivo para a API NestJS, que repassa ao storage.
- **Pros:** fluxo simples; validações centralizadas.
- **Cons:** viola o requisito principal; dobra tráfego e memória; degrada a API; ruim para 10GB.

### Option B: Presigned single PUT URL
- A API emite uma URL assinada única e o cliente faz um PUT direto do arquivo inteiro para o storage.
- **Pros:** remove a API do caminho de dados; implementação mais curta.
- **Cons:** fraco para 10GB; retry tende a reiniciar o arquivo inteiro; pouca granularidade para retomada.

### Option C: Presigned multipart upload direto ao storage
- A API cria uma sessão de upload e assina URLs por parte; o cliente envia partes diretamente ao storage e fecha o multipart ao final.
- **Pros:** atende 10GB com retry granular; retomada por parte; sem payload passando pela API; compatível com S3/MinIO.
- **Cons:** handshake mais complexo; exige persistir sessão/estado de partes; cliente precisa orquestrar `create → upload parts → list parts → complete/abort`.

### Option D: Protocolo resumable dedicado (ex.: tus)
- Um serviço/protocolo específico gerencia retomada e offsets.
- **Pros:** ótima experiência de retomada.
- **Cons:** adiciona outra superfície/proxy; foge da aderência direta ao storage S3-compatible.

**Recommendation:** **Presigned multipart upload direto ao storage**.

**Recommended Decision:** O cliente negocia uma sessão multipart direto com o storage S3-compatible. A API cria a sessão, devolve `UploadId` e presigned URLs de `UploadPart`, e conclui/aborta a sessão conforme o cliente reporta as partes concluídas.

**Rationale:**
- Presigned URLs multipart são suportadas nativamente por S3 e MinIO.
- Suporta 10GB com granularidade por parte e retomada sem reinício completo.
- A API permanece fora do caminho do binário.

**Consequences / Implications:**
- `CreateMultipartUpload` e `UploadPart` usam expiração normalizada de **1 hora (`3600s`)**.
- A sessão inclui `ListParts` para retomada/verificação e `CompleteMultipartUpload` para fechamento.
- O vídeo é criado como `draft` **antes** da sessão ser solicitada (ver TD-03).
- O fluxo canônico em `library-refs.md` usa apenas multipart presigned; `PutObject` simples não faz parte desta phase.

**Decision:** ✅ **Decidida** — Presigned multipart upload direto ao storage com expiração de 1 hora para a sessão de upload.

## TD-03: Upload Session Orchestration and Draft Creation

**Scope:** Cross-layer

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A plataforma precisa criar o vídeo como draft no momento em que o upload começa, e não apenas ao final, para manter rastreabilidade, ownership e possibilidade de retomar/limpar uploads incompletos.

**Options:**

### Option A: Criar o draft antes de emitir a sessão de upload
- A API cria o registro do vídeo em `draft`, gera `publicId`, cria a sessão de upload e devolve os dados de multipart ao cliente.
- **Pros:** ownership e auditoria desde o início; status consistente; facilita correlação e idempotência; worker sempre recebe um `videoId` persistido.
- **Cons:** acumula drafts órfãos se o usuário desistir cedo; precisa política de limpeza.

### Option B: Criar apenas uma upload session; draft nasce no primeiro chunk confirmado
- **Pros:** reduz drafts vazios.
- **Cons:** complica correlação entre sessão, owner e vídeo; aumenta lógica de recuperação.

### Option C: Criar o vídeo apenas após `complete multipart upload`
- **Pros:** zero drafts órfãos.
- **Cons:** contradiz o requisito; dificulta auditoria e idempotência.

**Recommendation:** **Criar o draft antes da sessão de upload**.

**Recommended Decision:** Antes de oferecer a sessão de upload multipart ao cliente, a API cria o vídeo no banco como `draft`, atribui um `publicId` imutável e registra ownership. Drafts criados e nunca concluídos são marcados para cleanup após **24 horas**.

**Rationale:**
- Toda entidade de negócio tem identidade imediata (`videoId`, `publicId`).
- Drafts órfãos são auditáveis e passíveis de limpeza automática.
- A fila de processamento sempre recebe um `videoId` conhecido.

**Consequences / Implications:**
- `draft_created_at` rastreia uploads órfãos.
- `upload_session_id` correlaciona o draft com a sessão multipart.
- Multipart incompleto é limpo preferencialmente por lifecycle nativo do S3/MinIO (`AbortIncompleteMultipartUpload.DaysAfterInitiation = 1`).
- A API pode complementar com auditoria periódica ou lazy cleanup consultando `draft_created_at + 24h < now()`.

**Decision:** ✅ **Decidida** — Criar draft antes da sessão multipart, com política de cleanup de 24 horas.

## TD-04: Video Processing Worker Architecture

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** A extração de metadados e geração de thumbnail não deve competir com threads/processo da API. A arquitetura precisa isolar CPU, memória e dependências binárias como FFmpeg/ffprobe.

**Options:**

### Option A: Consumer dentro do mesmo processo/container da API
- A API consome a fila e roda FFmpeg localmente no mesmo runtime.
- **Pros:** menos componentes; bootstrap inicial mais simples.
- **Cons:** acoplamento forte; risco de travar throughput da API; imagem/container da API fica pesado; escalonamento independente impossível.

### Option B: Worker dedicado em container/processo separado
- Um worker separado consome a fila, baixa/lê o objeto no storage, executa FFmpeg/ffprobe e atualiza banco/storage.
- **Pros:** isolamento operacional; escala separadamente; encaixa no diagrama C4; facilita limites de recursos distintos para API e mídia.
- **Cons:** mais um serviço para operar; exige contrato claro entre API, fila, storage e DB.

### Option C: Serviço externo/serverless de transcodificação
- O processamento fica fora do monorepo, acionado por evento ou API.
- **Pros:** reduz carga operacional local; elasticidade alta.
- **Cons:** custo e lock-in maiores; desalinhado com o worker explícito da arquitetura atual; local dev bem pior.

**Recommendation:** **Worker dedicado em container/processo separado** — é o desenho mais aderente à arquitetura já documentada e o mais seguro para preservar performance e isolamento da API.

**Recommended Decision:** O processamento de vídeos (FFmpeg, ffprobe, geração de thumbnail) executa em um container/processo separado da API NestJS, consumindo da fila BullMQ (TD-01). A API e o worker compartilham banco de dados e object storage, mas não executam na mesma imagem/processo.

**Rationale:**
- Isolamento operacional: CPU/memória/I/O do worker não competem com requisições HTTP da API.
- Escalonamento independente: se processamento virar gargalo, escalona worker sem mexer em API.
- Alinhamento com diagrama de arquitetura C4 (Video Worker é um container distinto).
- Limites de recursos podem ser definidos por container (resource requests/limits em Kubernetes/Docker).

**Consequences / Implications:**
- Exigir imagem Docker adicional para o worker com FFmpeg/ffprobe instalados (container base: ex., `node:XX` + FFmpeg).
- Worker consome jobs de fila BullMQ (acesso a Redis via variável de ambiente: `REDIS_URL=redis://redis:6379`).
- Acesso ao banco: usa mesma `DATABASE_URL` que API, conexão via repositório TypeORM.
- Acesso ao storage: usa SDK S3 para ler arquivo original e escrever thumbnail no storage.
- Recuperação após falha: BullMQ trata retries automáticos; worker registra tentativa e motivo na BD.
- Ciclo de vida do vídeo é atualizado pelo worker (draft → processing → ready | error).
- Healthcheck necessário: ambos API e worker devem reportar saúde separadamente.

**Decision:** ✅ **Decidida** — Arquitetura de worker separado. Imagem Docker específica = Pendente durante plan-build.

---

---

## TD-05: Metadata Extraction and Thumbnail Generation Policy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O worker precisa definir uma política consistente para extrair duração, resolução e metadados e também para gerar a thumbnail default com qualidade razoável, baixo custo e comportamento determinístico.

**Options:**

### Option A: `ffprobe` para metadados + thumbnail no primeiro frame
- **Pros:** implementação simples.
- **Cons:** o primeiro frame frequentemente é preto/fade-in.

### Option B: `ffprobe` para metadados + thumbnail em timestamp fixo
- **Pros:** simples.
- **Cons:** falha para vídeos curtos; ignora duração real.

### Option C: `ffprobe` para metadados + thumbnail em percentual da duração
- **Pros:** melhor qualidade média; adapta-se a vídeos curtos e longos; política previsível.
- **Cons:** um pouco mais de lógica.

**Recommendation:** **`ffprobe` + thumbnail em percentual da duração**.

**Recommended Decision:** O worker extrai metadados com `ffprobe`, persiste duração/resolução/codec/fps/bitrate em `metadata_json` e gera thumbnail default em ~25% da duração, com clamp mínimo/máximo.

**Rationale:**
- `ffprobe` é leve e confiável para leitura de metadados.
- Thumbnail em percentual adapta-se automaticamente ao tamanho do vídeo.
- A política é determinística e favorece idempotência.

**Consequences / Implications:**
- **Falha no `ffprobe`:** nenhum metadado é persistido; o job vai para `error`; `last_error_stack_trace` registra a stack; BullMQ aplica backoff exponencial até 5 tentativas.
- **`ffprobe` sucesso + thumbnail falha:** metadados são persistidos imediatamente; `thumbnail_url` pode permanecer `NULL`; retries seguintes pulam `ffprobe` quando `metadata_json` já é válido e tentam apenas o FFmpeg.
- **Esgotou 5 tentativas de thumbnail:** o vídeo pode transitar para `ready` sem thumbnail; a aplicação deve exibir placeholder quando `thumbnail_url` for nulo.
- Não há exclusão automática de objetos parciais quando o processamento falha permanentemente; eles ficam preservados para diagnóstico/manual cleanup futuro.
- A estratégia de runtime está consolidada em `library-refs.md`: FFmpeg/ffprobe como binários do container, sem pacote NPM adicional.

**Decision:** ✅ **Decidida** — `ffprobe` para metadados, thumbnail em percentual da duração e recuperação explícita para falhas parciais.

## TD-06: S3-Compatible Object Storage Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O requisito de storage S3-compatible já está decidido. Falta definir como organizar buckets, chaves, limpeza de multipart e exposição pública/privada dos objetos.

**Options:**

### Option A: Bucket único com prefixes por tipo/estado
- **Pros:** menos recursos para operar.
- **Cons:** ACL/policies ficam mais delicadas; lifecycle rules misturam ativos diferentes.

### Option B: Buckets separados por responsabilidade
- **Pros:** separação melhor de políticas; lifecycle diferente para originais e derivadas; mais seguro para uploads incompletos.
- **Cons:** mais configuração.

### Option C: Bucket por vídeo ou por canal
- **Pros:** isolamento extremo.
- **Cons:** explode cardinalidade operacional; complexidade desnecessária.

**Recommendation:** **Buckets separados por responsabilidade**.

**Recommended Decision:**
- **Bucket `videos-originals`** (privado): armazena o MP4 original após `complete multipart upload`. Estrutura: `{publicId}/original.mp4`. Acesso: apenas API autenticada ou URL assinada.
- **Bucket `videos-public`** (public-read): armazena apenas thumbnails default. Estrutura: `{publicId}/{publicId}_default.jpg`. Acesso: HTTP público.

**Rationale:**
- Buckets separados permitem políticas IAM e lifecycle diferentes.
- Streaming e download de vídeo continuam privados e controlados por assinatura.
- Exposição pública fica restrita a thumbnails.

**Consequences / Implications:**
- Streaming e download usam sempre URLs assinadas do bucket **privado** `videos-originals`.
- `videos-public` é reservado a thumbnails e outros assets públicos derivados, nunca ao vídeo MP4 original.
- O bucket de originais recebe regra de lifecycle para abortar multipart incompleto após 1 dia.
- Drafts órfãos são auditáveis via banco e podem ser objeto de cleanup lazy/periódico, sem depender de deleção imediata do objeto original.

**Decision:** ✅ **Decidida** — `videos-originals` privado para vídeo, `videos-public` apenas para thumbnails.

## TD-07: Public Video URL Identifier Strategy

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** A URL pública do vídeo precisa ser única, curta o suficiente para compartilhamento, imutável após publicação e independente de mudanças futuras no título.

**Options:**

### Option A: Slug baseado só no título
- A URL usa apenas o título normalizado.
- **Pros:** humana e amigável.
- **Cons:** colisões frequentes; precisa suffixes arbitrários; URL muda quando o título muda; lookup fica frágil.

### Option B: UUID puro
- O vídeo recebe um UUID como identificador público.
- **Pros:** unicidade simples; bom suporte em banco.
- **Cons:** URL longa e pouco amigável; experiência pior para compartilhamento.

### Option C: Identificador curto opaco (Base62/NanoID) e opcionalmente slug decorativo
- O sistema gera um `publicId` curto e imutável; se desejado, o título pode aparecer como slug não autoritativo na URL.
- **Pros:** unicidade robusta; URL curta; imutabilidade preservada; título pode mudar sem quebrar link.
- **Cons:** precisa definir alfabeto/tamanho e política de colisão; menos semântico do que título puro.

### Option D: Sequencial por canal
- Cada canal gera IDs próprios (`canal/123`).
- **Pros:** URLs mais previsíveis.
- **Cons:** coordenação adicional; enumeração fácil; muda contratos se o canal mudar de slug.

**Recommendation:** **Identificador curto opaco e imutável** — um `publicId` curto gerado com `nanoid` resolve colisão e imutabilidade melhor que slugs baseados em título; o slug textual pode ser apenas decorativo se o produto quiser legibilidade depois.

**Recommended Decision:** Cada vídeo recebe um `publicId` curto e opaco gerado com `nanoid(12)` (ex.: `a4Bx9Z2KlmN0`), atribuído no momento da criação do draft (TD-03) e **imutável pelo ciclo de vida do vídeo**. Alterações de título **não afetam** o `publicId`. A URL pública usa apenas `publicId`: ex., `/watch?v=a4Bx9Z2KlmN0`. Um slug decorativo baseado no título pode ser suportado mais tarde (ex., `/watch?v=a4Bx9Z2KlmN0&title=meu-video`) mas não é parte desta fase.

**Rationale:**
- `nanoid` gera strings curtas, URL-safe e visual-friendly.
- Geração aleatória garante baixíssima probabilidade de colisão para 12 caracteres.
- Imutabilidade: liens permanentes nunca quebram; título pode mudar sem afetar URLs compartilhadas.
- Simples de armazenar e consultar: unique index no banco + rápido.

**Consequences / Implications:**
- Campo `public_id` na tabela `videos`, unique, not null, indexed.
- Geração: usar `nanoid(12)`, conforme consolidado em `docs/phases/phase-03-videos/library-refs.md`.
- Lookup por `publicId` é a via principal de acesso público; auditoria de acesso pode usar correlação com `videoId` interno.
- URLs geradas: ex., `GET /videos/{publicId}` → retorna metadados + link de streaming.
- Estrutura S3 (TD-06) usa `{publicId}` como prefixo-chave.
- Unicidade no banco: constraint `UNIQUE(public_id)` garante que nenhum conflito chegue ao usuário.

**Decision:** ✅ **Decidida** — `publicId` curto, opaco e imutável gerado com `nanoid(12)`.

---

---

## TD-08: Streaming Delivery Strategy

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** A fase precisa permitir reprodução progressiva sem baixar o arquivo inteiro. É necessário escolher a estratégia considerando simplicidade, compatibilidade com object storage e suporte a `Range`/`206`.

**Options:**

### Option A: GET simples do arquivo inteiro
- **Pros:** menor esforço inicial.
- **Cons:** experiência ruim em seek; desperdício de banda.

### Option B: HTTP Range / `206 Partial Content` diretamente do object storage
- **Pros:** compatível com browsers/video tag; sem proxy pela API; suficiente para MP4 progressivo nesta fase.
- **Cons:** não oferece bitrate adaptativo.

### Option C: HLS/DASH segmentado
- **Pros:** melhor experiência de reprodução.
- **Cons:** adiciona transcoding e storage extra; escopo maior que a fase.

**Recommendation:** **HTTP Range / `206 Partial Content` direto do object storage**.

**Recommended Decision:** A API autoriza o acesso e devolve uma URL assinada de leitura do bucket `videos-originals`, com expiração de **30 minutos (`1800s`)**. O storage responde nativamente a `Range` com `206 Partial Content`.

**Rationale:**
- S3/MinIO suportam `Range` / `206` nativamente.
- Player HTML5 `<video>` suporta `Range` automaticamente.
- A API fica fora do caminho do stream.

**Consequences / Implications:**
- Cada nova sessão de reprodução pode renovar a URL assinada.
- Não há proxy da API para bytes de vídeo.
- Adaptive bitrate (HLS/DASH) permanece fora do escopo desta phase.

**Decision:** ✅ **Decidida** — Streaming via URL assinada de 30 minutos no bucket privado `videos-originals`.

## TD-09: Download Delivery Strategy

**Scope:** Cross-layer

**Capability:** Download do vídeo pelo usuário

**Context:** O download não pode fazer a API carregar o arquivo inteiro. Também precisa respeitar autorização/visibilidade e oferecer nome amigável ao usuário final.

**Options:**

### Option A: API faz proxy do arquivo
- **Pros:** autorização centralizada em um único hop.
- **Cons:** alto custo de rede/CPU na API; pior escala.

### Option B: API autoriza e devolve URL assinada de download
- **Pros:** arquivo continua fora da API; autorização centralizada; nome do arquivo pode ser controlado.
- **Cons:** requer expiração coerente; URLs precisam ser renováveis.

### Option C: Reutilizar a mesma URL pública do streaming como download
- **Pros:** zero handshake extra.
- **Cons:** menos controle sobre headers e autorização; expõe mais o ativo.

**Recommendation:** **API autoriza e devolve URL assinada de download**.

**Recommended Decision:** Quando o usuário solicita download, a API valida acesso e gera uma URL assinada de `GetObject` no bucket `videos-originals`, com `Content-Disposition: attachment` e expiração de **24 horas (`86400s`)**.

**Rationale:**
- A autorização continua centralizada na API.
- `Content-Disposition` força download sem proxy da API.
- 24 horas oferece janela adequada para arquivos grandes.

**Consequences / Implications:**
- Cliente pode requisitar nova URL caso a anterior expire.
- Logs do storage seguem sendo a principal trilha de observabilidade de downloads.
- O ciclo de vida do vídeo não é afetado por downloads; ele permanece `ready`.

**Decision:** ✅ **Decidida** — Download via URL assinada de 24 horas no bucket privado `videos-originals`.

## TD-10: Video Status Lifecycle and Recovery Model

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O domínio precisa refletir o ciclo pedido pela phase (`draft`, `processing`, `ready`, `error`) sem perder informação operacional sobre tentativas, falhas e limpeza de estado parcial.

**Options:**

### Option A: Expor e persistir apenas os quatro estados finais
- **Pros:** modelo simples.
- **Cons:** troubleshooting ruim; difícil distinguir upload incompleto de processamento em retry.

### Option B: Status externo enxuto + detalhes internos de pipeline
- **Pros:** API simples; boa observabilidade; retries e idempotência ficam explícitos.
- **Cons:** mais modelagem interna.

### Option C: Expor muitos estados finos (`uploading`, `queued`, `thumbnailing`, etc.)
- **Pros:** diagnóstico detalhado.
- **Cons:** acopla frontend ao pipeline interno; custo de manutenção alto.

**Recommendation:** **Status externo enxuto + detalhes internos de pipeline**.

**Recommended Decision:**

**Campos públicos (API):**
- `status: "draft" | "processing" | "ready" | "error"`
- `error_message: string | null` (apenas quando `status == "error"`)

**Campos internos na tabela `videos`:**
- `upload_session_id: string | null`
- `upload_completed_at: timestamp | null`
- `processing_started_at: timestamp | null`
- `processing_completed_at: timestamp | null`
- `processing_attempts: integer default 0`
- `last_error: text | null`
- `last_error_at: timestamp | null`
- `last_error_stack_trace: text | null`
- `draft_created_at: timestamp`
- `metadata_json: json | null`

**Transições canônicas:**
1. Draft criado: `status="draft"`, `draft_created_at=now()`
2. Upload completo: `status="draft"`, `upload_completed_at=now()`, publicar `video.process.requested`
3. Processamento iniciado: `status="draft"` → `"processing"`, `processing_started_at=now()`, `processing_attempts=1`
4. Sucesso completo: `status="processing"` → `"ready"`, `processing_completed_at=now()`
5. Falha de `ffprobe`: `status="processing"` → `"error"`, persistir `last_error`, `last_error_at`, `last_error_stack_trace`
6. Falha de thumbnail após metadados persistidos: manter tentativa no pipeline; retries pulam `ffprobe`
7. Esgotou retries de thumbnail: `status="processing"` → `"ready"` sem thumbnail; UI usa placeholder
8. Cleanup orphan: draft sem conclusão há mais de 24h é marcado para cleanup operacional

**Rationale:**
- O contrato público continua simples.
- As quatro colunas de erro/tentativa na própria tabela `videos` bastam para o estado atual.
- O histórico detalhado fica em logs estruturados/BullMQ logs, sem nova tabela de auditoria nesta phase.

**Consequences / Implications:**
- Schema SQL: adicionar colunas internas à tabela `videos`; **não** criar tabela separada de `processing_attempts`.
- Multipart incompleto é limpo por lifecycle do storage; o banco pode rodar auditoria opcional por `draft_created_at`.
- Reprocessamento manual/automático opera sobre as colunas da própria tabela `videos`.

**Decision:** ✅ **Decidida** — Status externo enxuto, colunas internas na tabela `videos` e sem tabela separada de tentativas.

## TD-11: Queue Messages and Event Contracts

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** A fila precisa de contratos estáveis para sustentar API, worker e futuras etapas de plan-build. Isso inclui payload mínimo, garantias de entrega, idempotência e configuração operacional consistente.

**Options:**

### Option A: Um único evento genérico de upload concluído
- **Pros:** menos tipos de mensagem.
- **Cons:** contrato ambíguo; mistura evento de domínio com comando operacional.

### Option B: Comando explícito para processamento + resultado persistido no banco
- **Pros:** semântica clara; payload mínimo; ordenação necessária apenas por `videoId`; encaixa bem com at-least-once + idempotência.
- **Cons:** menos orientado a eventos para múltiplos consumidores.

### Option C: Múltiplos eventos de cada microetapa na fila
- **Pros:** alta visibilidade e extensibilidade.
- **Cons:** contratos demais para a phase; ordering mais sensível.

**Recommendation:** **Comando explícito para processamento + resultado persistido no banco**.

**Recommended Decision:** Após o `complete multipart upload`, a API publica um comando `video.process.requested` na queue `video-processing`, usando job `process-video` e `jobId = video-${videoId}`. O worker consome idempotentemente e registra o resultado no banco.

**Payload de `video.process.requested`:**
```json
{
  "eventId": "evt-<uuid>",
  "occurredAt": "2026-09-23T15:35:00Z",
  "videoId": "<uuid>",
  "publicId": "a4Bx9Z2K",
  "ownerUserId": "<uuid>",
  "sourceBucket": "videos-originals",
  "sourceObjectKey": "a4Bx9Z2K/original.mp4",
  "storageProvider": "s3",
  "uploadSessionId": "<session-id>",
  "attempt": 1
}
```

**Idempotência canônica:**
- **enqueue dedup:** `jobId = video-${videoId}` impede novos enqueues paralelos independentes para o mesmo vídeo
- **worker preflight:** consultar `SELECT id, status FROM videos WHERE id = ? LIMIT 1`
- se `status = 'ready'`, o worker faz skip
- se `status = 'processing'`, o worker não inicia uma nova execução independente; retries do mesmo job BullMQ seguem o fluxo canônico
- se `status = 'error'`, retry é permitido
- se `status = 'draft'`, o processamento só prossegue após upload concluído

**Worker configuration consolidada:**
- queue name: `video-processing`
- job name: `process-video`
- attempts: `5`
- backoff: `exponential` com `delay: 2000ms`
- concurrency: `2`

**Rationale:**
- Semântica clara: é um comando operacional específico.
- `jobId` e preflight por status cobrem deduplicação em enqueue e reprocessamento indevido.
- Payload mínimo mantém baixo acoplamento entre API e worker.

**Consequences / Implications:**
- Logs estruturados devem incluir `eventId`, `videoId` e `jobId`.
- BullMQ controla backoff e retries; a tabela `videos` guarda apenas o estado resumido da última falha.
- Contratos adicionais (webhooks, notificações, etc.) ficam fora do escopo desta phase.

**Decision:** ✅ **Decidida** — `video.process.requested` via BullMQ, com `jobId=video-${videoId}` e configuração operacional consolidada.

## Decisions Summary

| ID | Scope | Decision | Recommended | Status |
|----|-------|----------|-------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ sobre Redis | ✅ Decidida |
| TD-02 | Cross-layer | Large File Upload Strategy | Presigned multipart upload direto ao storage | ✅ Decidida |
| TD-03 | Cross-layer | Upload Session Orchestration and Draft Creation | Criar o draft antes da sessão de upload + cleanup de 24h | ✅ Decidida |
| TD-04 | Backend | Video Processing Worker Architecture | Worker dedicado em container/processo separado | ✅ Decidida |
| TD-05 | Backend | Metadata Extraction and Thumbnail Generation Policy | `ffprobe` + thumbnail em percentual da duração + recuperação parcial | ✅ Decidida |
| TD-06 | Backend | S3-Compatible Object Storage Organization | `videos-originals` privado para vídeos + `videos-public` para thumbnails | ✅ Decidida |
| TD-07 | Cross-layer | Public Video URL Identifier Strategy | Identificador curto opaco e imutável | ✅ Decidida |
| TD-08 | Cross-layer | Streaming Delivery Strategy | HTTP Range / `206 Partial Content` direto do storage, URL de 30min | ✅ Decidida |
| TD-09 | Cross-layer | Download Delivery Strategy | API autoriza e devolve URL assinada de 24h | ✅ Decidida |
| TD-10 | Backend | Video Status Lifecycle and Recovery Model | Status externo enxuto + colunas internas em `videos` | ✅ Decidida |
| TD-11 | Backend | Queue Messages and Event Contracts | `video.process.requested` + `jobId=video-${videoId}` | ✅ Decidida |

## Architecture Decisions — Overview

Todas as 11 decisões arquiteturais desta phase estão **decididas**. As referências de biblioteca e APIs oficiais já foram consolidadas em `docs/phases/phase-03-videos/library-refs.md`.

Restam apenas detalhamentos de implementação para a etapa de build/especificação, como DTOs HTTP finais, IaC/Docker Compose e wiring de runtime. Não há dependências arquiteturais bloqueadas nesta documentação.
