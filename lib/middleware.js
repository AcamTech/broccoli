'use strict';

const path = require('path');
const fs = require('fs');

const handlebars = require('handlebars');
const url = require('url');
const mime = require('mime');

const errorTemplate = handlebars.compile(
  fs.readFileSync(path.resolve(__dirname, 'templates/error.html')).toString()
);
const dirTemplate = handlebars.compile(
  fs.readFileSync(path.resolve(__dirname, 'templates/dir.html')).toString()
);

// You must call watcher.start() before you call `getMiddleware`
//
// This middleware is for development use only. It hasn't been reviewed
// carefully enough to run on a production server.
//
// Supported options:
//   autoIndex (default: true) - set to false to disable directory listings
//   liveReloadPath - LiveReload script URL for error pages
module.exports = function getMiddleware(watcher, options) {
  if (options == null) options = {};
  if (options.autoIndex == null) options.autoIndex = true;

  const outputPath = watcher.builder.outputPath;

  return function broccoliMiddleware(request, response, next) {
    if (watcher.currentBuild == null) {
      throw new Error('Waiting for initial build to start');
    }
    watcher.currentBuild
      .then(
        () => {
          const urlObj = url.parse(request.url);
          let filename = path.join(outputPath, decodeURIComponent(urlObj.pathname));
          let stat, lastModified, type, charset, buffer;

          // contains null byte or escapes directory
          if (filename.indexOf('\0') !== -1 || filename.indexOf(outputPath) !== 0) {
            response.writeHead(400);
            response.end();
            return;
          }

          try {
            stat = fs.statSync(filename);
          } catch (e) {
            // not found
            next();
            return;
          }

          if (stat.isDirectory()) {
            const hasIndex = fs.existsSync(path.join(filename, 'index.html'));

            if (!hasIndex && !options.autoIndex) {
              next();
              return;
            }

            // If no trailing slash, redirect. We use path.sep because filename
            // has backslashes on Windows.
            if (filename[filename.length - 1] !== path.sep) {
              urlObj.pathname += '/';
              response.setHeader('Location', url.format(urlObj));
              response.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
              response.writeHead(301);
              response.end();
              return;
            }

            if (!hasIndex) {
              // implied: options.autoIndex is true
              const context = {
                url: request.url,
                files: fs
                  .readdirSync(filename)
                  .sort()
                  .map(child => {
                    const stat = fs.statSync(path.join(filename, child)),
                      isDir = stat.isDirectory();
                    return {
                      href: child + (isDir ? '/' : ''),
                      type: isDir
                        ? 'dir'
                        : path
                            .extname(child)
                            .replace('.', '')
                            .toLowerCase(),
                    };
                  }),
                liveReloadPath: options.liveReloadPath,
              };
              response.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
              response.writeHead(200);
              response.end(dirTemplate(context));
              return;
            }

            // otherwise serve index.html
            filename += 'index.html';
            stat = fs.statSync(filename);
          }

          lastModified = stat.mtime.toUTCString();
          response.setHeader('Last-Modified', lastModified);
          // nginx style treat last-modified as a tag since browsers echo it back
          if (request.headers['if-modified-since'] === lastModified) {
            response.writeHead(304);
            response.end();
            return;
          }

          type = mime.lookup(filename);
          charset = mime.charsets.lookup(type);
          if (charset) {
            type += '; charset=' + charset;
          }
          response.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
          response.setHeader('Content-Length', stat.size);
          response.setHeader('Content-Type', type);

          // read file sync so we don't hold open the file creating a race with
          // the builder (Windows does not allow us to delete while the file is open).
          buffer = fs.readFileSync(filename);
          response.writeHead(200);
          response.end(buffer);
        },
        buildError => {
          // All errors thrown from builder.build() are guaranteed to be
          // Builder.BuildError instances.
          const context = {
            stack: buildError.stack,
            liveReloadPath: options.liveReloadPath,
            payload: buildError.broccoliPayload,
          };
          response.setHeader('Content-Type', 'text/html');
          response.writeHead(500);
          response.end(errorTemplate(context));
        }
      )
      .catch(err => err.stack);
  };
};
