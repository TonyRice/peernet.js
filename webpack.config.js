const path = require('path');

// WIP - do not use
const webConfig = {
  entry: './src/esm.js',
  target: 'web',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'bundle.js'
  },
  mode: 'production',
  module: {
    rules: [
      {
        test: /\.m?js$/,
        exclude: /(node_modules|bower_components)/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [['@babel/preset-env',
              {
                modules: false,
              }]],
            plugins: [
              '@babel/plugin-proposal-private-methods',
              '@babel/plugin-proposal-class-properties',
              '@babel/plugin-transform-runtime'
            ]
          }
        }
      }
    ]
  },
  node : {
    fs: 'empty'
  }
};

// This is the main configuration object.
// Here you write different options and tell Webpack what to do
module.exports = [webConfig]
