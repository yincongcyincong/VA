.DEFAULT_GOAL := run
VA := ./bin/va.js

.PHONY: install run dev test status stop build build-win build-all audio-helper doubao-helper integrations

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

build-win:
	npm run build:win $(if $(ELECTRON_ZIP_DIR),-- --electron-zip-dir="$(ELECTRON_ZIP_DIR)")

build-all: build build-win

integrations:
	mkdir -p dist/integrations
	cd integrations && zip -q ../dist/integrations/astrbot_plugin_va.zip astrbot_plugin_va/main.py astrbot_plugin_va/metadata.yaml astrbot_plugin_va/_conf_schema.json
	npm pack ./integrations/openclaw --pack-destination dist/integrations

audio-helper: build/va-audio-monitor

doubao-helper: build/va-doubao-client build/va-doubao-captions

build/va-audio-monitor: native/AudioMonitor.swift
	mkdir -p build
	xcrun swiftc -parse-as-library -O $< -o $@

build/va-doubao-client: native/DoubaoClient.swift
	mkdir -p build
	xcrun swiftc -O $< -o $@

build/va-doubao-captions: native/DoubaoCaptions.swift
	mkdir -p build
	xcrun swiftc -parse-as-library -O $< -o $@
