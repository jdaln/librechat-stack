# LibreChat Stack Deployment Guide

This guide provides instructions for setting up and running the LibreChat stack locally, with a focus on a more secure deployment on Apple Silicon. At the moment and in this default configuration, this stack uses Google VertexAI subscription in its configuration due to their generous USD 300 credit.

This project is licensed under the Apache 2.0 License. See the [LICENSE](LICENSE) and [NOTICE](NOTICE) files for details.

## 1. Prerequisites

Before you begin, ensure you have the following installed:
- [Docker](https://www.docker.com/products/docker-desktop/)
- For macOS users: [Homebrew](https://brew.sh/)
- For macOS on Apple Silicon: [Colima][1]
- For local HTTPS: `mkcert` and `nss`


## 2. Initial Setup

### a. Secure Setup for Apple Silicon (M-series Macs)

For a secure setup on Apple Silicon, I would recommended to use Colima with Apple’s Virtualization.framework (`vz`). This allows to separately run different docker stacks on their own VMs, instead of all docker related things into one.

1.  **Start Colima with `vz`:**
    This creates a profile running on Apple's native VM layer.

    ```bash
    colima start -p aiarm --vm-type=vz --cpu 4 --memory 8 --disk 50
    docker context ls
    docker context use colima-aiarm
    ```
    *(Note: On macOS ≥13, recent Colima versions support the `--vz` shorthand.)*

2.  **Enable user-namespace remapping:**
    This maps "root in the container" to an unprivileged user in the VM, enhancing security.

    ```bash
    colima ssh -p aiarm
    echo '{ "userns-remap": "default" }' | sudo tee /etc/docker/daemon.json
    echo 'dockremap:165536:65536' | sudo tee -a /etc/subuid /etc/subgid
    sudo systemctl restart docker || sudo service docker restart
    exit
    ```

### b. Environment Configuration

The application stack is configured using an environment file.

1.  **Create the `.env` file:**
    Copy the template to create your local configuration file.
    ```bash
    cp template_dot_env .env
    ```

2.  **Configure variables in `.env`:**
    Open `.env` and set the required variables.  

## 3. Running the Stack

With the configuration in place, you can now start the services.

1.  **Ensure your Docker context is correct:**
    ```bash
    docker context use colima-aiarm
    ```

2.  **Start the services:**
    ```bash
    docker compose \
      -f docker-compose.yml \
      -f compose.hardening.yml \
      up -d
    ```

3.  **Check running services:**
    To see the published ports for the services:
    ```bash
    docker compose ps --format '{{.Service}} -> {{range .Publishers}}{{.PublishedPort}}{{end}}'
    ```

## 4. Post-Installation

### Create an Admin User

After the stack is running, create the first user, who will have admin privileges.
```bash
docker compose -f docker-compose.yml -f compose.hardening.yml exec api npm run create-user
```

## 5. Advanced Configuration

### Optional: Enable Static Preview Server

If you need to use the static preview server for artifacts, you can enable it by including its dedicated compose file. This service, along with a Caddy proxy, provides a local HTTPS endpoint for `sandpack`. I have not yet fully understood how it really works with LibreChat, nethertheless I got it to run.

1.  **Prerequisites:**
    Ensure you have generated the local SSL certificates using `mkcert`.

    You can install `mkcert` and `nss` via Homebrew:

    ```bash
    brew install mkcert nss
    mkcert -install
    ```

2. **Local HTTPS with `mkcert` and `sslip.io`**

    Generate a self-signed SSL certificate for local development domains.

    ```bash
    # Create a directory for secrets if it doesn't exist
    mkdir -p ./secrets

    # Generate cert/key files for the local wildcard host
    mkcert -cert-file ./secrets/sslip.crt -key-file ./secrets/sslip.key \
      "preview.127.0.0.1.sslip.io" "*.127.0.0.1.sslip.io"
    ```

2.  **Start the stack with the static preview service:**
    Add the `-f optional/static-preview/compose.yml` flag to your `docker compose up` command:

    ```bash
    docker compose \
      --env-file .env \
      -f docker-compose.yml \
      -f compose.hardening.yml \
      -f optional/static-preview/compose.yml \
      up -d
    ```

## 6. Troubleshooting & Verification

### Quick Checks

-   **Verify variables are set in `.env`:**
    ```bash
    grep -E '^(PORT|UID|GID|MEILI_MASTER_KEY|RAG_PORT)=' .env
    ```

-   **Preview the resolved Docker Compose configuration:**
    This helps confirm that your `.env` variables are being loaded correctly. You should not see any warnings about missing variables.
    ```bash
    docker compose --env-file .env config | sed -n '1,60p'
    ```
    If you still see warnings, it means `.env` isn’t being picked up—double-check the path and that you passed `--env-file .env`.

## 7. Volume backup procedure.

For backup procedure, see [`backup/README.md`](backup/README.md).

## Acknowledgements

The foundation of this Docker Compose stack was adapted from the work of [nicedexter](https://github.com/nicedexter). His original setup provided a great starting point for this.


## TODO

- Fix CORS for artifacts
- Egress squid proxy to prevent successful LLM Prompt hijacking efficiently by whitelisting needed egress domains


[1]: https://github.com/abiosoft/colima "GitHub - abiosoft/colima: Container runtimes on macOS (and Linux) with minimal setup"
