default:
    @just --list

fmt:
    npx prettier --write '**/*.ts' '**/*.json' '**/*.md'
    shfmt --indent=4 --language-dialect=posix --simplify --write *.sh
    yamlfmt -- .github/workflows/*.yml

lint:
    npm run typecheck
    npm run lint
    mandoc -man -Wall -Tlint -- man/man1/*.1
    markdownlint *.md
    shellcheck --enable all *.sh
    shfmt --diff --indent=4 --language-dialect=posix --simplify *.sh
    yamlfmt -lint -- .github/workflows/*.yml

test *args:
    npm test -- {{args}}

coverage:
    npm run coverage
