.PHONY: test dev deploy

test:
	npx vitest run

# --host keeps minted links on localhost; without it wrangler dev uses the custom domain
dev:
	npx wrangler dev --host localhost:8787

deploy:
	npx wrangler deploy

# Deploy to a celld fleet. celld-secrets.sh (not committed) exports the
# secrets and bucket credentials; see bin/celld-config.
deploy-celld:
	. ./celld-secrets.sh && bin/celld-config wrangler.celld.jsonc > wrangler.celld.generated.json \
	  && PATH=$$HOME/.local/bin:$$PWD/node_modules/.bin:$$PATH celld deploy wrangler.celld.generated.json \
	       --bucket $$CELLD_BUCKET --endpoint $$S3_ENDPOINT --region $$AWS_REGION; \
	  status=$$?; rm -f wrangler.celld.generated.json; exit $$status
