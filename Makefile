.PHONY: test check publish cws-publish clean

test:
	node scripts/check-scaffold.mjs
	for file in scripts/test-*.mjs; do node "$$file"; done

check: test
	find src scripts -type f \( -name '*.js' -o -name '*.mjs' \) -print0 | xargs -0 -n1 node --check

publish:
	node scripts/package-cws.mjs

cws-publish: publish
	node scripts/cws-publish.mjs

clean:
	rm -rf dist
