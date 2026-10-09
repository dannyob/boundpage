.PHONY: test dev deploy

test:
	npx vitest run

dev:
	npx wrangler dev

deploy:
	npx wrangler deploy
