'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});

var _extends = Object.assign || function (target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i]; for (var key in source) { if (Object.prototype.hasOwnProperty.call(source, key)) { target[key] = source[key]; } } } return target; };

var _lodash = require('lodash');

var _lodash2 = _interopRequireDefault(_lodash);

var _irc = require('irc');

var _irc2 = _interopRequireDefault(_irc);

var _winston = require('winston');

var _winston2 = _interopRequireDefault(_winston);

var _discord = require('discord.js');

var _discord2 = _interopRequireDefault(_discord);

var _errors = require('./errors');

var _validators = require('./validators');

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

const REQUIRED_FIELDS = ['server', 'nickname', 'channelMapping', 'discordToken'];
const NICK_COLORS = ['light_blue', 'dark_blue', 'light_red', 'dark_red', 'light_green', 'dark_green', 'magenta', 'light_magenta', 'orange', 'yellow', 'cyan', 'light_cyan'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options - server, nickname, channelMapping, outgoingToken, incomingURL
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach(field => {
      if (!options[field]) {
        throw new _errors.ConfigurationError(`Missing configuration field ${ field }`);
      }
    });

    (0, _validators.validateChannelMapping)(options.channelMapping);

    this.discord = new _discord2.default.Client({ autoReconnect: true });

    this.server = options.server;
    this.nickname = options.nickname;
    this.ircOptions = options.ircOptions;
    this.discordToken = options.discordToken;
    this.commandCharacters = options.commandCharacters || [];
    this.ircNickColor = options.ircNickColor !== false; // default to true
    this.channels = _lodash2.default.values(options.channelMapping);

    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _lodash2.default.forOwn(options.channelMapping, (ircChan, discordChan) => {
      this.channelMapping[discordChan] = ircChan.split(' ')[0].toLowerCase();
    });

    this.invertedMapping = _lodash2.default.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    _winston2.default.debug('Connecting to IRC and Discord');
    this.discord.login(this.discordToken);

    const ircOptions = _extends({
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      retryCount: 10
    }, this.ircOptions);

    this.ircClient = new _irc2.default.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.discord.on('ready', () => {
      _winston2.default.debug('Connected to Discord');
    });

    this.ircClient.on('registered', message => {
      _winston2.default.debug('Registered event: ', message);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', error => {
      _winston2.default.error('Received error event from IRC', error);
    });

    this.discord.on('error', error => {
      _winston2.default.error('Received error event from Discord', error);
    });

    this.discord.on('message', message => {
      // Ignore bot messages and people leaving/joining
      this.sendToIRC(message);
    });

    this.ircClient.on('message', this.sendToDiscord.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      this.sendToDiscord(author, to, `*${ text }*`);
    });

    this.ircClient.on('action', (author, to, text) => {
      this.sendToDiscord(author, to, `_${ text }_`);
    });

    this.ircClient.on('invite', (channel, from) => {
      _winston2.default.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        _winston2.default.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        _winston2.default.debug('Joining channel:', channel);
      }
    });
  }

  parseText(message) {
    const text = message.mentions.users.reduce((content, mention) => content.replace(`<@${ mention.id }>`, `@${ mention.username }`).replace(`<@!${ mention.id }>`, `@${ mention.username }`), message.content);

    return text.replace(/\n|\r\n|\r/g, ' ').replace(/<#(\d+)>/g, (match, channelId) => {
      const channel = this.discord.channels.get(channelId);
      return `#${ channel.name }`;
    }).replace(/<(:\w+:)\d+>/g, (match, emoteName) => emoteName);
  }

  isCommandMessage(message) {
    return this.commandCharacters.indexOf(message[0]) !== -1;
  }

  sendToIRC(message) {
    const author = message.author;
    // Ignore messages sent by the bot itself:
    if (author.id === this.discord.user.id) return;

    const channelName = `#${ message.channel.name }`;
    const ircChannel = this.channelMapping[channelName];

    _winston2.default.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      const username = author.username;
      let text = this.parseText(message);
      let displayUsername = username;
      if (this.ircNickColor) {
        const colorIndex = (username.charCodeAt(0) + username.length) % NICK_COLORS.length;
        displayUsername = _irc2.default.colors.wrap(NICK_COLORS[colorIndex], username);
      }

      if (this.isCommandMessage(text)) {
        const prelude = `Command sent from Discord by ${ username }:`;
        this.ircClient.say(ircChannel, prelude);
        this.ircClient.say(ircChannel, text);
      } else {
        if (text !== '') {
          text = `<${ displayUsername }> ${ text }`;
          _winston2.default.debug('Sending message to IRC', ircChannel, text);
          this.ircClient.say(ircChannel, text);
        }

        if (message.attachments && message.attachments.length) {
          message.attachments.forEach(a => {
            const urlMessage = `<${ displayUsername }> ${ a.url }`;
            _winston2.default.debug('Sending attachment URL to IRC', ircChannel, urlMessage);
            this.ircClient.say(ircChannel, urlMessage);
          });
        }
      }
    }
  }

  sendToDiscord(author, channel, text) {
    const discordChannelName = this.invertedMapping[channel.toLowerCase()];
    if (discordChannelName) {
      // #channel -> channel before retrieving:
      const discordChannel = this.discord.channels.find('name', discordChannelName.slice(1));

      if (!discordChannel) {
        _winston2.default.info('Tried to send a message to a channel the bot isn\'t in: ', discordChannelName);
        return;
      }

      const withMentions = text.replace(/@[^\s]+\b/g, match => {
        const user = this.discord.users.find('username', match.substring(1));
        return user || match;
      });

      // Add bold formatting:
      const withAuthor = `**<${ author }>** ${ withMentions }`;
      _winston2.default.debug('Sending message to Discord', withAuthor, channel, '->', discordChannelName);
      discordChannel.sendMessage(withAuthor);
    }
  }
}

exports.default = Bot;