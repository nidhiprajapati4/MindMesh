import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertFetchableUrl, fetchUrlMetadata, isPublicAddress, parseHtmlMetadata } from './url-metadata';

describe('isPublicAddress', () => {
  it('blocks loopback, private, link-local and metadata addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.5', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      assert.equal(isPublicAddress(ip), false, ip);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(isPublicAddress(ip), true, ip);
  });
});

describe('assertFetchableUrl', () => {
  it('rejects non-http schemes, credentials, odd ports and local hosts', () => {
    for (const u of ['file:///etc/passwd', 'ftp://example.com', 'http://user:pw@example.com', 'http://example.com:8080', 'http://127.0.0.1', 'http://[::1]/', 'http://localhost', 'http://169.254.169.254/latest/meta-data']) {
      assert.throws(() => assertFetchableUrl(u), u);
    }
  });

  it('accepts ordinary URLs', () => {
    assert.equal(assertFetchableUrl('https://example.com/a?b=c').hostname, 'example.com');
  });

  it('refuses hostnames that resolve to private addresses', async () => {
    // localtest.me style names resolve to 127.0.0.1; use the literal-free path via a .localhost-free name.
    await assert.rejects(fetchUrlMetadata('http://127.0.0.1.nip.io/'), /not allowed|ENOTFOUND|EAI_AGAIN/);
  });
});

describe('parseHtmlMetadata', () => {
  it('prefers Open Graph tags and decodes entities', () => {
    const html = `<html><head><title>Fallback</title>
      <meta property="og:title" content="Retry &amp; Backoff">
      <meta name='description' content='How to retry safely'>
      <meta property="og:site_name" content=Blog>
      <meta name="author" content="Dana"></head></html>`;
    assert.deepEqual(parseHtmlMetadata(html), { title: 'Retry & Backoff', description: 'How to retry safely', siteName: 'Blog', author: 'Dana' });
  });

  it('falls back to <title>', () => {
    assert.equal(parseHtmlMetadata('<title>\n  Hello   world </title>').title, 'Hello world');
  });
});
