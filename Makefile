.PHONY: dev dev-backend dev-web build build-backend build-web start \
       typecheck typecheck-backend typecheck-web typecheck-agent-runner \
		_build-ar-if-stale _build-backend-if-stale _build-web-if-stale _check-sync _ensure-builtin-skills _ensure-docker-image backup check-container-sdk clean ensure-latest-codex-sdk ensure-latest-sdk format format-check help install install-host-tools launchd-install launchd-log launchd-restart launchd-status launchd-uninstall logs reset-init restore status stop sync-types update-codex-sdk update-sdk

# ─── Runtime ────────────────────────────────────────────────
# 本项目只用原生 Node 工具链运行（npm / npx / tsx / node），不使用 bun。
# 原因：主服务的 WebSocket 走 `ws` 包 + @hono/node-server 的 `server.on('upgrade')`
# 握手，该模式在 bun 的 HTTP server 下不触发，会导致 WS 全部握手失败（HTTP/接口正常，
# 但前端实时流式卡片/通知全失效，飞书等 stdout 通道不受影响）。
PORT    ?= $(or $(WEB_PORT),3000)
# Container image name — mirrors the CONTAINER_IMAGE env default in src/config.ts.
CONTAINER_IMAGE ?= happyclaw-agent:latest
export WEB_PORT := $(PORT)
PKG     := npm
RUN     := npx
RUNNER  := npx tsx src/index.ts
RUNTIME_DATA_DIR ?= data
BACKUP_DIR ?= .

# ─── Development ─────────────────────────────────────────────

dev: ## 启动前后端（首次自动安装依赖和构建容器镜像）
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ package-lock.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ web/package-lock.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ] || [ container/agent-runner/package-lock.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-builtin-skills
	@$(MAKE) _ensure-docker-image
	@$(PKG) --prefix container/agent-runner run build --silent 2>/dev/null || $(PKG) --prefix container/agent-runner run build
	@echo "🚀 使用 $(PKG) 启动..."
	$(PKG) run dev:all

dev-backend: ## 仅启动后端（tsx 直跑 TS）
	$(RUNNER)

dev-web: ## 仅启动前端
	cd web && $(PKG) run dev

# ─── Build ───────────────────────────────────────────────────

build: sync-types ## 编译前后端及 agent-runner
	$(PKG) run build:all
	@touch .build-sentinel

build-backend: ## 仅编译后端
	$(PKG) run build

build-web: ## 仅编译前端
	cd web && $(PKG) run build

# ─── Production ──────────────────────────────────────────────

start: ensure-latest-sdk ensure-latest-codex-sdk check-container-sdk ## 一键启动生产环境（前台阻塞运行）
	@# 生产启动不得隐式改写依赖图；SDK 升级请显式执行 make update-sdk，
	@# 验证通过后再提交 package.json 与 lockfile。
	@# 检查端口是否被占用
	@if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "❌ 端口 $(PORT) 已被占用，请先停掉旧进程：make stop"; \
	  lsof -ti:$(PORT) -sTCP:LISTEN | xargs ps -fp 2>/dev/null | tail -1; \
	  exit 1; \
	fi
	@if [ ! -d node_modules ] || [ package.json -nt node_modules ] || [ package-lock.json -nt node_modules ] || [ web/package.json -nt web/node_modules ] || [ web/package-lock.json -nt web/node_modules ] || [ container/agent-runner/package.json -nt container/agent-runner/node_modules ] || [ container/agent-runner/package-lock.json -nt container/agent-runner/node_modules ]; then echo "📦 依赖有更新，安装依赖..."; $(MAKE) install; fi
	@$(MAKE) _ensure-builtin-skills
	@$(MAKE) _ensure-docker-image
	@$(MAKE) _check-sync
	@$(MAKE) _build-backend-if-stale
	@$(MAKE) _build-web-if-stale
	@$(MAKE) _build-ar-if-stale
	@echo "🟢 Node 模式：运行编译后的 dist/index.js（本项目不使用 bun，WebSocket 需要 node）"
	node dist/index.js

# ─── Internal build checks ────────────────────────────────────

_check-sync: ## (内部) 检测 shared/ 类型变更并同步
	@NEED_SYNC=0; \
	for target in src/stream-event.types.ts web/src/stream-event.types.ts container/agent-runner/src/stream-event.types.ts src/image-detector.ts container/agent-runner/src/image-detector.ts src/channel-prefixes.ts container/agent-runner/src/channel-prefixes.ts; do \
	  if [ ! -f "$$target" ] || [ -n "$$(find shared/ -newer "$$target" -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_SYNC=1; break; fi; \
	done; \
	if [ "$$NEED_SYNC" = "1" ]; then echo "🔄 检测到 shared/ 类型变更，同步类型..."; $(MAKE) sync-types; fi

_ensure-builtin-skills: ## (内部) 物化固定版本、Host/Container 共用的内置 Skills
	@if ! node scripts/builtin-skill-catalog.mjs validate data/builtin-skills; then \
	  echo "📚 固定版本内置 Skills 缺失，正在物化..."; \
	  ./scripts/install-host-tools.sh skills; \
	else \
	  echo "✅ 内置 Skills catalog 已就绪"; \
	fi

_build-web-if-stale: ## (内部) 前端变更时重新编译
	@NEED_WEB=0; \
	if [ ! -f web/dist/index.html ]; then NEED_WEB=1; \
	else \
	  for f in web/package.json web/vite.config.ts web/index.html web/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt web/dist/index.html ]; then NEED_WEB=1; break; fi; \
	  done; \
	  if [ "$$NEED_WEB" = "0" ] && [ -n "$$(find web/src/ web/public/ -type f -newer web/dist/index.html 2>/dev/null | head -1)" ]; then NEED_WEB=1; fi; \
	fi; \
	if [ "$$NEED_WEB" = "1" ]; then echo "🔨 检测到前端变更，重新编译前端..."; cd web && $(PKG) run build; else echo "✅ 前端无变更，跳过编译"; fi

_build-ar-if-stale: ## (内部) agent-runner 变更时重新编译
	@NEED_AR=0; \
	if [ ! -f container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; \
	else \
	  for f in container/agent-runner/package.json container/agent-runner/tsconfig.json; do \
	    if [ -f "$$f" ] && [ "$$f" -nt container/agent-runner/dist/.tsbuildinfo ]; then NEED_AR=1; break; fi; \
	  done; \
	  if [ "$$NEED_AR" = "0" ] && [ -n "$$(find container/agent-runner/src/ -newer container/agent-runner/dist/.tsbuildinfo -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_AR=1; fi; \
	fi; \
	if [ "$$NEED_AR" = "1" ]; then echo "🔨 检测到 agent-runner 变更，重新编译..."; cd container/agent-runner && $(PKG) run build; else echo "✅ agent-runner 无变更，跳过编译"; fi

_build-backend-if-stale: ## (内部) 后端变更时重新编译（Node 模式）
	@NEED_BACKEND=0; \
	if [ ! -f dist/index.js ]; then NEED_BACKEND=1; \
	else \
	  for f in package.json tsconfig.json; do \
	    if [ "$$f" -nt dist/index.js ]; then NEED_BACKEND=1; break; fi; \
	  done; \
	  if [ "$$NEED_BACKEND" = "0" ] && [ -n "$$(find src/ -newer dist/index.js -name '*.ts' 2>/dev/null | head -1)" ]; then NEED_BACKEND=1; fi; \
	fi; \
	if [ "$$NEED_BACKEND" = "1" ]; then echo "🔨 检测到后端源码变更，重新编译后端..."; $(PKG) run build; else echo "✅ 后端无变更，跳过编译"; fi

logs: ## 实时查看日志（需配合手动后台运行：make start > /tmp/happyclaw.log 2>&1 &）
	@tail -f /tmp/happyclaw.log

stop: ## 停止监听指定端口的服务进程
	@lsof -ti:$(PORT) -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null && echo "✅ 已停止 HappyClaw (端口 $(PORT))" || echo "⚠️  端口 $(PORT) 未被占用，无需停止"

status: ## 查看服务运行状态
	@echo "=== HappyClaw 服务状态 ==="
	@if lsof -ti:$(PORT) -sTCP:LISTEN >/dev/null 2>&1; then \
	  echo "✅ 后端进程: 运行中 (端口 $(PORT))"; \
	  curl -s http://localhost:$(PORT)/api/health 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"   健康状态: {d.get('status','unknown')}\")" 2>/dev/null || echo "   健康状态: 无法获取"; \
	else \
	  echo "❌ 后端进程: 未运行 (端口 $(PORT) 未占用)"; \
	fi
	@echo ""
	@echo "=== 日志文件 ==="
	@if [ -f /tmp/happyclaw.log ]; then \
	  echo "✅ /tmp/happyclaw.log 存在 ($$(wc -l < /tmp/happyclaw.log) 行)"; \
	  echo "   最近 3 行:"; \
	  tail -3 /tmp/happyclaw.log | sed 's/^/   /'; \
	else \
	  echo "⚠️  /tmp/happyclaw.log 不存在（未用后台模式启动）"; \
	fi
	@echo ""
	@echo "=== Docker 容器 ==="
	@docker ps --filter "name=happyclaw" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "   Docker 未运行或无 HappyClaw 容器"

# ─── Quality ─────────────────────────────────────────────────

typecheck: sync-types typecheck-backend typecheck-web typecheck-agent-runner ## 全量类型检查
	@./scripts/check-stream-event-sync.sh
	@./scripts/check-agent-runner-prompts.sh
	@$(PKG) run docs:check

typecheck-backend:
	$(RUN) tsc --noEmit

typecheck-web:
	cd web && $(RUN) tsc --noEmit

typecheck-agent-runner:
	cd container/agent-runner && $(RUN) tsc --noEmit

test: ## 运行单元测试
	$(RUN) vitest run

format: ## 格式化代码
	$(PKG) run format

format-check: ## 检查代码格式
	$(PKG) run format:check

# ─── Docker Image ─────────────────────────────────────────────

# Docker 镜像源文件：Dockerfile、entrypoint.sh、agent-runner 源码和运行时 prompts
DOCKER_SRC := container/Dockerfile container/entrypoint.sh \
	container/agent-runner/package.json \
	$(wildcard container/agent-runner/src/*.ts) \
	$(shell find container/agent-runner/prompts -type f 2>/dev/null)

_ensure-docker-image: ## (内部) 检测 Docker 镜像是否需要构建/重建
	@if command -v docker >/dev/null 2>&1; then \
	  if ! docker image inspect happyclaw-agent:latest >/dev/null 2>&1; then \
	    echo "🐳 Docker 镜像不存在，正在构建..."; \
	    ./container/build.sh; \
	  elif [ ! -f .docker-build-sentinel ]; then \
	    echo "🐳 Docker 镜像 sentinel 缺失，正在重建..."; \
	    ./container/build.sh; \
	  else \
	    STALE=0; \
	    for f in $(DOCKER_SRC); do \
	      if [ "$$f" -nt .docker-build-sentinel ]; then STALE=1; break; fi; \
	    done; \
	    if [ "$$STALE" = "1" ]; then \
	      echo "🐳 检测到容器源码变更，正在重建 Docker 镜像..."; \
	      ./container/build.sh; \
	    else \
	      echo "✅ Docker 镜像无需重建"; \
	    fi; \
	  fi; \
	fi

# ─── Shared Types ────────────────────────────────────────────

sync-types: ## 同步 shared/ 下的类型定义到各子项目
	@./scripts/sync-stream-event.sh

# ─── SDK ─────────────────────────────────────────────────────

update-sdk: ## 显式更新 agent-runner + 主服务的 Claude Agent SDK 到最新版本
	@SDK_LATEST=$$(npm view @anthropic-ai/claude-agent-sdk version --fetch-timeout=5000); \
	CLI_LATEST=$$(npm view @anthropic-ai/claude-code version --fetch-timeout=5000); \
	echo "🔄 更新 Agent SDK → $$SDK_LATEST，Claude Code → $$CLI_LATEST"; \
	$(PKG) --prefix container/agent-runner install --save-exact \
	  @anthropic-ai/claude-agent-sdk@$$SDK_LATEST \
	  @anthropic-ai/claude-code@$$CLI_LATEST; \
	$(PKG) install --save-exact @anthropic-ai/claude-agent-sdk@$$SDK_LATEST; \
	$(PKG) --prefix container/agent-runner run build; \
	echo "✅ SDK/CLI 与 runner lockfile 已更新。请运行 make typecheck && make test 验证。"

update-codex-sdk: ## 更新宿主服务与 agent-runner 的 Codex SDK 到最新版本
	$(PKG) update @openai/codex-sdk
	cd container/agent-runner && $(PKG) update @openai/codex-sdk && $(PKG) run build
	@# npm/bun update 会将 "*" 回写为具体版本，还原它
	@sed -i '' 's/"@openai\/codex-sdk": "[^"]*"/"@openai\/codex-sdk": "*"/' package.json
	@sed -i '' 's/"@openai\/codex-sdk": "[^"]*"/"@openai\/codex-sdk": "*"/' container/agent-runner/package.json
	@echo "Codex SDK updated. Run 'make typecheck' to verify."

ensure-latest-sdk: ## 启动前自动检测并更新 SDK（agent-runner + 主服务，有新版才更新）
ensure-latest-sdk: ## 只读检查 SDK/CLI 最新版本（兼容旧工作流）
	@LOCAL=$$(node -p "require('./container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	ROOT_LOCAL=$$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	CLI_LOCAL=$$(node -p "require('./container/agent-runner/node_modules/@anthropic-ai/claude-code/package.json').version" 2>/dev/null || echo "0.0.0"); \
	LATEST=$$(npm view @anthropic-ai/claude-agent-sdk version --fetch-timeout=5000 2>/dev/null || echo "$$LOCAL"); \
	if [ "$$LOCAL" != "$$LATEST" ]; then \
		echo "🔄 [agent-runner] Claude Agent SDK 有新版本: $$LOCAL → $$LATEST，正在更新..."; \
		if (cd container/agent-runner && $(PKG) update --include=dev @anthropic-ai/claude-agent-sdk && $(PKG) run build); then \
			sed -i '' 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' container/agent-runner/package.json; \
			echo "✅ [agent-runner] SDK 更新完成（内置 Claude Code 版本随之更新）"; \
		else \
			echo "❌ [agent-runner] SDK $$LATEST 构建失败"; \
			if [ "$$LOCAL" != "0.0.0" ]; then \
				echo "↩️  回滚到 $$LOCAL ..."; \
				(cd container/agent-runner && $(PKG) install --include=dev @anthropic-ai/claude-agent-sdk@$$LOCAL && $(PKG) run build) \
					|| echo "⚠️  回滚构建也失败，dist 可能是陈旧产物——请手动检查 container/agent-runner"; \
			else \
				echo "⚠️  无可回滚的版本（此前未安装）"; \
			fi; \
			echo "⚠️  跳过主服务 SDK 更新，避免两侧版本分叉"; \
			exit 1; \
		fi; \
	else \
		echo "✅ [agent-runner] Claude Agent SDK 已是最新 ($$LOCAL)"; \
	fi; \
	if [ "$$ROOT_LOCAL" != "$$LATEST" ]; then \
		echo "🔄 [主服务] Claude Agent SDK 有新版本: $$ROOT_LOCAL → $$LATEST，正在更新..."; \
		$(PKG) update --include=dev @anthropic-ai/claude-agent-sdk; \
		sed -i '' 's/"@anthropic-ai\/claude-agent-sdk": "[^"]*"/"@anthropic-ai\/claude-agent-sdk": "*"/' package.json; \
		echo "✅ [主服务] SDK 更新完成"; \
	else \
		echo "✅ [主服务] Claude Agent SDK 已是最新 ($$ROOT_LOCAL)"; \
	fi

check-container-sdk: ## 检查 Docker 镜像内的 SDK 是否落后于宿主机
	@if ! docker image inspect $(CONTAINER_IMAGE) >/dev/null 2>&1; then \
		echo "ℹ️  镜像 $(CONTAINER_IMAGE) 不存在，跳过检查（container 模式工作区将无法启动）"; \
		exit 0; \
	fi; \
	HOST_CODEX=$$(node -p "require('./container/agent-runner/node_modules/@openai/codex-sdk/package.json').version" 2>/dev/null || echo ""); \
	IMG_CODEX=$$(docker run --rm --entrypoint sh $(CONTAINER_IMAGE) -c "cat /app/node_modules/@openai/codex-sdk/package.json 2>/dev/null" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version)}catch{console.log('')}})" || echo ""); \
	HOST_CLAUDE=$$(node -p "require('./container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/package.json').version" 2>/dev/null || echo ""); \
	IMG_CLAUDE=$$(docker run --rm --entrypoint sh $(CONTAINER_IMAGE) -c "cat /app/node_modules/@anthropic-ai/claude-agent-sdk/package.json 2>/dev/null" 2>/dev/null | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).version)}catch{console.log('')}})" || echo ""); \
	STALE=0; \
	if [ -n "$$IMG_CODEX" ] && [ -n "$$HOST_CODEX" ] && [ "$$IMG_CODEX" != "$$HOST_CODEX" ]; then \
		echo "⚠️  Codex SDK 落后：镜像 $$IMG_CODEX ≠ 宿主机 $$HOST_CODEX"; STALE=1; \
	fi; \
	if [ -n "$$IMG_CLAUDE" ] && [ -n "$$HOST_CLAUDE" ] && [ "$$IMG_CLAUDE" != "$$HOST_CLAUDE" ]; then \
		echo "⚠️  Claude SDK 落后：镜像 $$IMG_CLAUDE ≠ 宿主机 $$HOST_CLAUDE"; STALE=1; \
	fi; \
	if [ "$$STALE" = "1" ]; then \
		echo "⚠️  container 模式工作区跑的是镜像内的旧 SDK，新模型可能不被识别。"; \
		echo "⚠️  重建镜像：./container/build.sh"; \
	else \
		echo "✅ 镜像 SDK 与宿主机一致"; \
	fi

ensure-latest-codex-sdk: ## 启动前自动检测并更新 Codex SDK（有新版才更新）
	@HOST_LOCAL=$$(node -p "require('./node_modules/@openai/codex-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	RUNNER_LOCAL=$$(node -p "require('./container/agent-runner/node_modules/@openai/codex-sdk/package.json').version" 2>/dev/null || echo "0.0.0"); \
	LOCAL="$$HOST_LOCAL"; \
	if [ "$$RUNNER_LOCAL" = "0.0.0" ]; then LOCAL="0.0.0"; fi; \
	LATEST=$$(npm view @openai/codex-sdk version --fetch-timeout=5000 2>/dev/null || echo "$$LOCAL"); \
	if [ "$$LOCAL" != "$$LATEST" ]; then \
		echo "🔄 Codex SDK 有新版本或未安装: host=$$HOST_LOCAL, runner=$$RUNNER_LOCAL → $$LATEST，正在更新..."; \
		$(PKG) update --include=dev @openai/codex-sdk; \
		if (cd container/agent-runner && $(PKG) update --include=dev @openai/codex-sdk && $(PKG) run build); then \
			sed -i '' 's/"@openai\/codex-sdk": "[^"]*"/"@openai\/codex-sdk": "*"/' package.json; \
			sed -i '' 's/"@openai\/codex-sdk": "[^"]*"/"@openai\/codex-sdk": "*"/' container/agent-runner/package.json; \
			echo "✅ Codex SDK 更新完成"; \
		else \
			echo "❌ Codex SDK $$LATEST 构建失败"; \
			if [ "$$RUNNER_LOCAL" != "0.0.0" ]; then \
				echo "↩️  回滚到 $$RUNNER_LOCAL ..."; \
				$(PKG) install --include=dev @openai/codex-sdk@$$RUNNER_LOCAL; \
				(cd container/agent-runner && $(PKG) install --include=dev @openai/codex-sdk@$$RUNNER_LOCAL && $(PKG) run build) \
					|| echo "⚠️  回滚构建也失败，dist 可能是陈旧产物——请手动检查 container/agent-runner"; \
			else \
				echo "⚠️  无可回滚的版本（此前未安装）"; \
			fi; \
			exit 1; \
		fi; \
	else \
		echo "✅ Codex SDK 已是最新 ($$LOCAL)"; \
	fi

# ─── feishu-cli ──────────────────────────────────────────────

FEISHU_CLI_BIN := bin/feishu-cli

$(FEISHU_CLI_BIN): ## 下载 feishu-cli 到项目 bin/（自动检测平台）
	@mkdir -p bin
	@ARCH=$$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/'); \
	OS=$$(uname -s | tr '[:upper:]' '[:lower:]'); \
	VERSION=$$(curl -sI "https://github.com/riba2534/feishu-cli/releases/latest" \
		| grep -i '^location:' | head -1 \
		| sed 's|.*/tag/\([^[:space:]]*\).*|\1|' | tr -d '\r\n'); \
	if [ -z "$$VERSION" ]; then echo "❌ 无法获取 feishu-cli 最新版本"; exit 1; fi; \
	echo "📥 下载 feishu-cli $$VERSION ($$OS-$$ARCH)..."; \
	curl -fsSL "https://github.com/riba2534/feishu-cli/releases/download/$${VERSION}/feishu-cli_$${VERSION}_$${OS}-$${ARCH}.tar.gz" \
		| tar -xz --strip-components=1 -C bin; \
	chmod +x bin/feishu-cli; \
	echo "✅ feishu-cli $$VERSION → bin/feishu-cli"

update-feishu-cli: ## 更新 feishu-cli 到最新版本
	@rm -f $(FEISHU_CLI_BIN)
	@$(MAKE) $(FEISHU_CLI_BIN)

# ─── Setup ───────────────────────────────────────────────────

install-host-tools: ## 安装宿主工具 + 刷新 Host/Container 共用的固定版本 builtin-skills Manifest 源
	@./scripts/install-host-tools.sh

install: ## 安装全部依赖并编译 agent-runner
	$(PKG) ci
	@# node-pty 的 spawn-helper 预构建二进制可能缺少可执行权限，导致 PTY 模式失败
	@chmod +x node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper 2>/dev/null || true
	cd container/agent-runner && $(PKG) ci
	cd container/agent-runner && $(PKG) run build
	cd web && $(PKG) ci
	@$(MAKE) _ensure-builtin-skills
	@# 更新目录 mtime 以配合 start 中的依赖变更检测（[ package.json -nt node_modules ]）
	@touch node_modules web/node_modules container/agent-runner/node_modules

clean: ## 清理构建产物
	rm -rf dist
	rm -rf web/dist
	rm -rf container/agent-runner/dist
	rm -f .build-sentinel .docker-build-sentinel

reset-init: ## 完全重置为首装状态（清空所有运行时数据）
	rm -rf data store groups
	@echo "✅ 已完全重置为首装状态（数据库、配置、工作区、记忆、会话全部清除）"

# ─── Backup / Restore ────────────────────────────────────────

backup: ## 备份运行时数据到 happyclaw-backup-{date}.tar.gz
	@set -eu; \
	DATE=$$(date +%Y%m%d-%H%M%S); \
	mkdir -p "$(BACKUP_DIR)"; \
	FILE="$(BACKUP_DIR)/happyclaw-backup-$$DATE.tar.gz"; \
	if [ -e "$$FILE" ]; then FILE="$(BACKUP_DIR)/happyclaw-backup-$$DATE-$$$$.tar.gz"; fi; \
	TMP_FILE="$$FILE.tmp-$$$$"; \
	TMP_ROOT=$$(mktemp -d "$${TMPDIR:-/tmp}/happyclaw-backup.XXXXXX"); \
	trap 'rm -rf "$$TMP_ROOT" "$$TMP_FILE"' EXIT INT TERM; \
	mkdir -p "$$TMP_ROOT/data/db"; \
	echo "📦 正在创建 SQLite 一致性快照..."; \
	node scripts/sqlite-snapshot.mjs \
	  "$(RUNTIME_DATA_DIR)/db/messages.db" \
	  "$$TMP_ROOT/data/db/messages.db"; \
	for DIR in config groups sessions skills mcp-servers plugins memory avatars extra builtin-skills; do \
	  if [ -d "$(RUNTIME_DATA_DIR)/$$DIR" ]; then \
	    mkdir -p "$$TMP_ROOT/data/$$DIR"; \
	    cp -a "$(RUNTIME_DATA_DIR)/$$DIR/." "$$TMP_ROOT/data/$$DIR/"; \
	  fi; \
	done; \
	node scripts/prepare-backup-tree.mjs "$$TMP_ROOT/data"; \
	UNSAFE_ENTRY=$$(find "$$TMP_ROOT/data" \( -type l -o \( ! -type f ! -type d \) \) -print -quit); \
	if [ -n "$$UNSAFE_ENTRY" ]; then \
	  echo "❌ 运行时数据包含不安全的链接或特殊文件，拒绝创建不可安全恢复的备份：$$UNSAFE_ENTRY"; \
	  exit 1; \
	fi; \
	: "检查源目录而非 TMP_ROOT：macOS 的 cp -a 不保留硬链接（GNU cp -a 才保留），"; \
	: "拷贝后 nlink already 降为 1，对副本检查在 macOS 上恒不触发。"; \
	HARDLINK_ENTRY=$$(find "$(RUNTIME_DATA_DIR)" -type f -links +1 -print -quit); \
	if [ -n "$$HARDLINK_ENTRY" ]; then \
	  echo "❌ 运行时数据包含硬链接文件，tar 会将其存为不完整的链接条目导致备份无法恢复，拒绝创建：$$HARDLINK_ENTRY"; \
	  exit 1; \
	fi; \
	if [ -d "$$TMP_ROOT/data/groups" ]; then \
	  find "$$TMP_ROOT/data/groups" -mindepth 2 -maxdepth 2 -type d -name logs \
	    -prune -exec rm -rf {} +; \
	fi; \
	node scripts/backup-manifest.mjs "$$TMP_ROOT/data"; \
	echo "📦 正在打包备份到 $$FILE ..."; \
	tar -czf "$$TMP_FILE" -C "$$TMP_ROOT" data; \
	mv "$$TMP_FILE" "$$FILE"; \
	chmod 600 "$$FILE"; \
	echo "✅ 备份完成：$$FILE ($$(du -sh "$$FILE" | cut -f1))"

restore: ## 从 happyclaw-backup-*.tar.gz 恢复数据（用法：make restore 或 make restore FILE=xxx.tar.gz）
	@set -eu; \
	if [ -n "$(FILE)" ]; then \
	  BACKUP="$(FILE)"; \
	elif [ $$(find "$(BACKUP_DIR)" -maxdepth 1 -type f -name 'happyclaw-backup-*.tar.gz' 2>/dev/null | wc -l) -eq 1 ]; then \
	  BACKUP=$$(find "$(BACKUP_DIR)" -maxdepth 1 -type f -name 'happyclaw-backup-*.tar.gz' | head -1); \
	elif [ $$(find "$(BACKUP_DIR)" -maxdepth 1 -type f -name 'happyclaw-backup-*.tar.gz' 2>/dev/null | wc -l) -gt 1 ]; then \
	  echo "❌ 发现多个备份文件，请用 make restore FILE=xxx.tar.gz 指定："; \
	  find "$(BACKUP_DIR)" -maxdepth 1 -type f -name 'happyclaw-backup-*.tar.gz' -print; \
	  exit 1; \
	else \
	  echo "❌ 未找到备份文件，请将 happyclaw-backup-*.tar.gz 放到当前目录"; \
	  exit 1; \
	fi; \
	if [ ! -f "$$BACKUP" ]; then \
	  echo "❌ 备份文件不存在：$$BACKUP"; \
	  exit 1; \
	fi; \
	if ! node scripts/restore-backup.mjs assert-port-free "$(PORT)"; then \
	  echo "❌ 检测到运行中的服务，拒绝覆盖数据库"; \
	  exit 1; \
	fi; \
	echo "📂 正在从 $$BACKUP 恢复..."; \
	if [ -d "$(RUNTIME_DATA_DIR)" ] && [ "$$(ls -A "$(RUNTIME_DATA_DIR)" 2>/dev/null)" ]; then \
	  echo "⚠️  $(RUNTIME_DATA_DIR)/ 目录已存在数据，继续将覆盖。是否继续？[y/N] "; \
	  read CONFIRM; \
	  [ "$$CONFIRM" = "y" ] || [ "$$CONFIRM" = "Y" ] || { echo "已取消"; exit 1; }; \
	fi; \
	node scripts/restore-backup.mjs restore "$$BACKUP" "$(RUNTIME_DATA_DIR)" "$(PORT)"; \
	if [ ! -f "$(RUNTIME_DATA_DIR)/config/session-secret.key" ]; then \
	  echo "⚠️  警告：备份中缺少 session-secret.key，用户登录 cookie 将失效，需重新登录"; \
	fi; \
	echo "✅ 数据恢复完成"; \
	echo ""; \
	echo "后续步骤："; \
	echo "  1. 如需 Docker 容器支持：./container/build.sh"; \
	echo "  2. 启动服务：make start"

# ─── Launchd (macOS 进程守护) ────────────────────────────────

PLIST_TEMPLATE = config/com.happyclaw.plist
PLIST_DST = $(HOME)/Library/LaunchAgents/com.happyclaw.plist
NODE_BIN = $(shell which node)
PROJECT_DIR = $(shell pwd)

launchd-install: build ## 安装 launchd 守护（开机自启 + 立即启动）
	@if [ -z "$(NODE_BIN)" ]; then echo "❌ 找不到 node，请确保 PATH 正确"; exit 1; fi
	@# 检测冲突的 launchd 服务（同名 happyclaw 但不同 Label）
	@for f in $(HOME)/Library/LaunchAgents/com.happyclaw*.plist; do \
		[ -f "$$f" ] || continue; \
		[ "$$f" = "$(PLIST_DST)" ] && continue; \
		label=$$(defaults read "$$f" Label 2>/dev/null); \
		echo "⚠️  发现冲突的 launchd 服务: $$f (Label: $$label)"; \
		echo "   请先卸载: launchctl bootout gui/$$(id -u)/$$label && rm $$f"; \
		exit 1; \
	done
	@mkdir -p $(HOME)/Library/LaunchAgents
	@sed \
		-e 's|__NODE_BIN__|$(NODE_BIN)|g' \
		-e 's|__PROJECT_DIR__|$(PROJECT_DIR)|g' \
		-e 's|__HOME__|$(HOME)|g' \
		$(PLIST_TEMPLATE) > $(PLIST_DST)
	launchctl load $(PLIST_DST)
	@echo "✅ HappyClaw 已注册为 launchd 服务（开机自启）"
	@echo "   node:    $(NODE_BIN)"
	@echo "   project: $(PROJECT_DIR)"
	@echo "   状态：make launchd-status"
	@echo "   日志：make launchd-log"

launchd-uninstall: ## 卸载 launchd 守护（停止 + 取消开机自启）
	-launchctl unload $(PLIST_DST) 2>/dev/null
	-rm -f $(PLIST_DST)
	@echo "✅ HappyClaw launchd 服务已卸载"

launchd-restart: ## 重启 launchd 守护的 HappyClaw
	launchctl kickstart -k gui/$$(id -u)/com.happyclaw
	@echo "✅ HappyClaw 已重启"

launchd-status: ## 查看 launchd 守护状态
	@launchctl print gui/$$(id -u)/com.happyclaw 2>/dev/null || echo "❌ 服务未注册，请先 make launchd-install"

launchd-log: ## 查看 launchd 守护日志（最近 50 行）
	@echo "=== stdout ===" && tail -50 data/launchd-stdout.log 2>/dev/null || echo "(empty)"
	@echo "\n=== stderr ===" && tail -50 data/launchd-stderr.log 2>/dev/null || echo "(empty)"

# ─── Help ────────────────────────────────────────────────────

help: ## 显示帮助
	@echo "运行时: 🟢 Node.js（本项目不使用 bun）"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
