.PHONY: test dev deploy

test:
	npx vitest run

# --host keeps minted links on localhost; without it wrangler dev uses the custom domain
dev:
	npx wrangler dev --host localhost:8787

deploy:
	npx wrangler deploy
