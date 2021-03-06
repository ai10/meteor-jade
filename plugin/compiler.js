// This compiler is based on the meteor core Spacebars compiler. The main goal
// of this object is to transform the jade syntax-tree to a spacebars
// syntax-tree.
//
// XXX Source-mapping: Jade give us the line number, so we could implement a
// simple line-mapping but it's not yet supported by the spacebars compiler.

Compiler = function(tree, filename) {
  var self = this;
  self.tree = tree;
  self.filename = filename;
  self.head = null;
  self.body = null;
  self.templates = {};
}

_.extend(Compiler.prototype, {

  compile: function () {
    var self = this;
    self.visitBlock(self.tree, 0);
    return {
      head: self.head,
      body: self.body,
      templates: self.templates
    }
  },

  visitBlock: function (block, level) {
    if (_.isUndefined(block) || _.isNull(block) || ! _.has(block, 'nodes'))
      return null;

    var self = this;
    var buffer = [];
    var nodes = block.nodes;
    var current, elseNode, stack, stackElements;

    for (var i = 0; i < nodes.length; i++) {
      var currentNode = nodes[i];
      var elseNode = null;

      // If the node is a Mixin (ie Component), we check if there are some
      // `else if` and `else` blocks after it and if so, we groups thoses 
      // nodes by two with the following transformation:
      // if a               if a
      // else if b          else
      // else          =>     if b
      //                      else
      
      if (currentNode.type === "Mixin") {
        // Define stack potentials elements
        if (currentNode.name === "if")
          stackElements = ["else if", "else"];
        else
          stackElements = ["else"];


        // Create the stack [nodeIf, nodeElseIf..., nodeElse]
        stack = [];
        while (nodes[i+1] && nodes[i+1].type === "Mixin" &&
               stackElements.indexOf(nodes[i+1].name) !== -1) {
          stack.push(nodes[++i])
        }

        // Transform the stack
        elseNode = stack.shift() || null;
        if (elseNode && elseNode.name === "else if") {
          elseNode.name = "if";
          elseNode = {
            name: "else",
            type: "Mixin",
            block: { nodes: [elseNode].concat(stack) },
            call: false
          }
        }
      }

      buffer.push(self.visitNode(currentNode, elseNode, level + 1));
    }

    return buffer;
  },

  visitNode: function(node, elseNode, level) {
    var self = this;
    var attrs = self.visitAttributes(node.attrs);
    var content = (node.code) ? [ self.visitCode(node.code) ] : 
                                             self.visitBlock(node.block, level);
    var elseContent = self.visitBlock(elseNode && elseNode.block, level);

    if (level === 1)
      return self.registerRootNode(node, content)
    else
      return self['visit' + node.type](node, attrs, content, elseContent);
  },

  visitCode: function(code) {
    // XXX Need to improve this for "anonymous helpers"
    return this.lookup(code.val, code.escape);
  },

  // We interpret "Mixins" as "Components"
  // Thanks to our customize Lexer, `if`, `unless`, `with` and `each` are
  // retrieved as Mixins by the parser
  visitMixin: function(node, attrs, content, elseContent) {
    var self = this;
    var componentName = node.name;
    var spacebarsSymbol = content === null ? ">" : "#";
    var args = node.args || "";
    var tag = Spacebars.TemplateTag.parse("{{" + spacebarsSymbol + 
                                             componentName + " " + args + "}}");
    if (content !== null)
      tag.content = content;

    if (elseContent !== null)
      tag.elseContent = elseContent;

    return HTML.Special(tag);
  },

  visitTag: function(node, attrs, content) {
    var self = this;
    var tagName = node.name.toUpperCase();

    if (! HTML.isTagEnsured(tagName))
      self.throwError("Unknow tag: " + tagName, node);

    if (! _.isEmpty(attrs))
      content.unshift(attrs);

    return HTML[tagName].apply(undefined, content);
  },

  visitText: function(node) {
    var self = this;
    return node.val ? self.parseText(node.val) : null;
  },

  parseText: function(text) {
    // The parser doesn't parse the #{expression} syntax. Let's do it.
    // Since we rely on the Spacebars parser for this, we support the
    // {{mustache}} syntax as well.
    var self = this;
    var jadeExpression = /#\{\s*((\.{1,2}\/)*[\w\.-]+)\s*\}/
    text = text.replace(jadeExpression, "{{$1}}");
    return Spacebars.parse(text);
  },

  visitComment: function (comment) {
    // If buffer boolean is true we want to display this comment in the DOM
    if (comment.buffer)
      return HTML.Comment(comment.val)
  },

  visitBlockComment: function (comment) {
    var self = this;
    comment.val = "\n" + _.pluck(comment.block.nodes, "val").join("\n") + "\n";
    return self.visitComment(comment)
  },

  visitElse: function (node) {
    var self = this;
    self.throwError("Unexpected else block", node);
  },

  visitFilter: function (filter, attrs, content) {
    var self = this;
    if (Filters[filter.name])
      return self.parseText(Filters[filter.name](content.join("\n")));
    else
      self.throwError("Unknowed filter " + filter.name, filter);
  },

  visitAttributes: function (attrs) {
    // The jade parser provide an attribute tree of this type:
    // [{name: "class", val: "val1", escaped: true }, {name: "id" val: "val2"}]
    // Let's transform that into:
    // {"class": "val1", id: "val2"}
    // Moreover if an "id" or "class" attribute is used more than once we need
    // to concatenate the values.

    if (_.isUndefined(attrs))
      return;

    if (_.isString(attrs))
      return attrs;

    var self = this;
    var dict = {};

    _.each(attrs, function (attr) {
      var val = attr.val;
      var key = attr.name;

      // XXX We need a better handler for JavaScript code
      var quotes = ["'", '"'];
      if (quotes.indexOf(val.slice(0, 1)) !== -1 && 
        val.slice(-1) === val.slice(0, 1))
        // First case this is a string
        val = val.slice(1, -1);
      else
        // Otherwise this is some code we need to evaluate
        val = self.lookup(val, attr.escaped);

      if (key === "$dyn")
        key = "$specials";

      // If a user has defined such kind of tag: div.myClass(class="myClass2")
      // we need to concatenate classes (and ids)
      if ((dict["class"] && key === "class") ||
          (dict["id"] && key === "id"))
        dict[key].push(" ", val)
      else if (dict["$specials"] && key === "$specials")
        dict[key].push(val)
      else
        dict[key] = [val];
    });

    return dict;
  },

  lookup: function (val, escape) {
    if (escape)
      spacebarsSymbol = "{{" + val + "}}";
    else
      spacebarsSymbol = "{{{" + val + "}}}";
    return Spacebars.TemplateTag.parse(spacebarsSymbol);
  },

  registerRootNode: function(node, result) {
    // XXX This is mostly the same code as the `templating` core package
    // The `templating` package should be more generic to allow others templates
    // engine to use its methods.

    var self = this;

    // Ignore top level comments
    if (node.type === "Comment" || node.type === "BlockComment" ||
        node.type === "TAG" && _.isUndefined(node.name)) {
    }

    // Doctypes
    else if (node.type === "Doctype") {
      console.warn("Meteor sets the doctype for you (line " + node.line + ")");
    }

    // There are two specials templates: head and body
    else if (node.name === "body" || node.name === "head") {
      var template = node.name;

      if (self[template] !== null)
        self.throwError("<" + template + "> is set twice", node);
      if (node.attrs.length !== 0)
        self.throwError("Attributes on <" + template +"> not supported", node);

      self[template] = result;
    } 

    // Templates
    else if (node.name === "template") {
      if (node.attrs.length !== 1 || node.attrs[0].name !== 'name')
        self.throwError('Templates must have only a "name" attribute', node);
      
      var name = self.visitAttributes(node.attrs).name;

      if (name === "content")
        self.throwError('Template can\'t be named "content"', node);
      if (_.has(self.templates, name))
        self.throwError('Template "' + name + '" is defined twice', node);

      self.templates[name] = result;
    }

    // Otherwise this is an error, we do not allow tags, mixins, if, etc.
    // outside templates
    else
      self.throwError(node.type + ' must be in a template', node);
  },

  throwError: function (message, node) {
    message = message || "Syntax error";
    if (node.line)
      message += " on line " + node.line;

    throw message;
  }
});
