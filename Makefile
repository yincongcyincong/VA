.DEFAULT_GOAL := run
VA := ./bin/va.js
MACOS_ARCH ?= $(shell uname -m)

.PHONY: install run dev test status stop build dmg audio-helper doubao-helper zipvoice-tts integrations

install:
	npm ci
	./node_modules/.bin/install-electron

run:
	$(VA) start

dev: audio-helper doubao-helper
	npm start

test:
	npm test

status:
	$(VA) status --json

stop:
	$(VA) quit

build:
	npm run build:mac $(if $(ELECTRON_ZIP_DIR),-- --electron-zip-dir="$(ELECTRON_ZIP_DIR)")

dmg:
	npm run build:dmg $(if $(ELECTRON_ZIP_DIR),-- --electron-zip-dir="$(ELECTRON_ZIP_DIR)")

zipvoice-tts:
	bash scripts/install-zipvoice.sh

integrations:
	mkdir -p dist/integrations
	cd integrations && zip -q ../dist/integrations/astrbot_plugin_va.zip astrbot_plugin_va/main.py astrbot_plugin_va/metadata.yaml astrbot_plugin_va/_conf_schema.json
	npm pack ./integrations/openclaw --pack-destination dist/integrations

audio-helper: build/va-audio-monitor

doubao-helper: build/va-doubao-client build/va-doubao-captions

build/va-audio-monitor: native/AudioMonitor.swift Makefile
	mkdir -p build
	xcrun swiftc -target $(MACOS_ARCH)-apple-macosx13.0 -parse-as-library -O $< -o $@

build/va-doubao-client: native/DoubaoClient.swift Makefile
	mkdir -p build
	xcrun swiftc -target $(MACOS_ARCH)-apple-macosx13.0 -O $< -o $@

build/va-doubao-captions: native/DoubaoCaptions.swift Makefile
	mkdir -p build
	xcrun swiftc -target $(MACOS_ARCH)-apple-macosx26.0 -parse-as-library -O $< -o $@
