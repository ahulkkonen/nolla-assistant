---
name: web-digest
description: Fetch one web page from any host and summarise it. Use when the user gives a URL and asks what it says. Fetch only the URL the user gave.
sandbox:
  network: internet
---

# Web digest

1. Fetch only the URL the user gave. Do not fetch other pages, links on the page or other hosts.
   Fetch the page with the `bash` tool:

   ```sh
   curl -sL <url> | head -c 20000
   ```

2. If the output is HTML, ignore scripts, styles and navigation. Read the main text.
3. Write a short summary in the user's language: the main point first, then at most five key facts.
4. Give the URL as the source. If the fetch fails, tell the user the error. Do not guess the content.
