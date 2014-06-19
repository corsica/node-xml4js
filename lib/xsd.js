var crypto = require('crypto');
var moment = require('moment');
var request = require('request');
var util = require('util');
var xml2js = require('xml2js');
var _ = require('underscore');

var assert = require('./assert');
var multivalue = require('./multivalue');

var BASE_NAMESPACES = {
  'http://www.w3.org/XML/1998/namespace': 'xml'
};

// We store XML Schema names without a prefix

var BASE_TYPES = {};

BASE_TYPES.string = BASE_TYPES.normalizedString = BASE_TYPES.token = BASE_TYPES.language = BASE_TYPES.NMTOKEN = BASE_TYPES.Name = BASE_TYPES.NCName = BASE_TYPES.ID = BASE_TYPES.IDREF = BASE_TYPES.ENTITY = {
  parse: function (value) {
    return value;
  }
};

BASE_TYPES.NMTOKENS = BASE_TYPES.IDREFS = BASE_TYPES.ENTITIES = {
  parse: function (value) {
    return value.split(/\s+/);
  }
};

BASE_TYPES.boolean = {
  parse: function (value) {
    return _.contains(['true', 'false', '0', '1'], value.toLowerCase());
  }
};

BASE_TYPES.integer = BASE_TYPES.nonPositiveInteger = BASE_TYPES.negativeInteger = BASE_TYPES.long = BASE_TYPES.int = BASE_TYPES.short = BASE_TYPES.byte = BASE_TYPES.nonNegativeInteger = BASE_TYPES.unsignedLong = BASE_TYPES.unsignedInt = BASE_TYPES.unsignedShort = BASE_TYPES.unsignedByte = BASE_TYPES.positiveInteger = {
  parse: function (value) {
    return parseInt(value);
  }
};

BASE_TYPES.decimal = {
  parse: function (value) {
    return parseFloat(value);
  }
};

BASE_TYPES.double = BASE_TYPES.float = {
  parse: function (value) {
    if (value.toLowerCase() === 'inf') {
      value = 'Infinity';
    }
    else if (value.toLowerCase() === '-inf') {
      value = '-Infinity';
    }
    return parseFloat(value);
  }
};

BASE_TYPES.dateTime = BASE_TYPES.date = {
  parse: function (value) {
    return moment.utc(value).toDate();
  }
};

BASE_TYPES.hexBinary = {
  parse: function (value) {
    return new Buffer(value, 'hex');
  }
};

BASE_TYPES.base64Binary = {
  parse: function (value) {
    return new Buffer(value, 'base64');
  }
};

BASE_TYPES.anyURI = {
  parse: function (value) {
    return value;
  }
};

// duration, time, gYearMonth, gYear, gMonthDay, gDay, gMonth, QName, NOTATION not implemented, for now leave them as a string
// TODO: What would be the best JavaScript object to convert them to?
BASE_TYPES.duration = BASE_TYPES.time = BASE_TYPES.gYearMonth = BASE_TYPES.gYear = BASE_TYPES.gMonthDay = BASE_TYPES.gDay = BASE_TYPES.gMonth = BASE_TYPES.QName = BASE_TYPES.NOTATION = {
  parse: function (value) {
    return value;
  }
};

var XS_TYPES = _.keys(BASE_TYPES);

function randomString() {
  return crypto.pseudoRandomBytes(10).toString('hex');
}

function XsdSchema(parser, namespace, xsPrefix) {
  var self = this;
  self.parser = parser;
  self.namespace = namespace;
  self.xsPrefix = xsPrefix;
}

// Similar to validator.namespacedName, just that it uses xsPrefix as well
XsdSchema.prototype.namespacedName = function (name) {
  var self = this;

  assert(name);

  // XML Schema names are the only one we process without a prefix, so we remove everywhere the prefix
  if (self.xsPrefix) {
    var xsPrefixRegex = new RegExp('^' + self.xsPrefix);
    if (xsPrefixRegex.test(name)) {
      return name.replace(xsPrefixRegex, '');
    }
  }

  if (/:/.test(name)) {
    return name;
  }
  else {
    return self.namespace + ':' + name;
  }
};

XsdSchema.prototype.namespacedTypeName = function (name) {
  var self = this;

  assert(name);
  // We do not prefix XML Schema defined types
  if (_.indexOf(XS_TYPES, name) !== -1) {
    return name;
  }
  else {
    return self.namespacedName(name);
  }
};

XsdSchema.prototype.parseIsArray = function (input, isArrayDefault) {
  var self = this;

  var isArray = _.isBoolean(isArrayDefault) ? isArrayDefault : null;
  if (input.$) {
    if (input.$.maxOccurs) {
      isArray = input.$.maxOccurs === 'unbounded' || parseInt(input.$.maxOccurs) > 1;
    }
    delete input.$.minOccurs;
    delete input.$.maxOccurs;
  }
  return isArray;
};

XsdSchema.prototype.parseTypesChoice = function (input, isArrayDefault) {
  var self = this;

  var children = {};
  if (input[self.xsPrefix + 'choice']) {
    assert(input[self.xsPrefix + 'choice'].length === 1, input[self.xsPrefix + 'choice']);
    var choice = input[self.xsPrefix + 'choice'][0];
    isArrayDefault = self.parseIsArray(choice, isArrayDefault);
    delete choice.$;
    _.extend(children, self.parseElements(choice, isArrayDefault));
    assert(_.isEmpty(choice), choice);
  }
  delete input[self.xsPrefix + 'choice'];
  return children;
};

XsdSchema.prototype.parseTypesSequence = function (input) {
  var self = this;

  var type = {};
  if (input[self.xsPrefix + 'sequence']) {
    assert(input[self.xsPrefix + 'sequence'].length === 1, input[self.xsPrefix + 'sequence']);
    var sequence = input[self.xsPrefix + 'sequence'][0];
    var children = {};
    var isArrayDefault = self.parseIsArray(sequence);
    delete sequence.$;
    _.extend(children, self.parseElements(sequence, isArrayDefault));
    _.extend(children, self.parseTypesChoice(sequence, isArrayDefault));
    if (sequence[self.xsPrefix + 'any']) {
      assert(sequence[self.xsPrefix + 'any'].length === 1, sequence[self.xsPrefix + 'any']);
      type.anyChildren = true;
      var isArray = self.parseIsArray(sequence[self.xsPrefix + 'any'][0], isArrayDefault);
      if (_.isBoolean(isArray)) {
        type.isArray = isArray;
      }
    }
    delete sequence[self.xsPrefix + 'any'];
    assert(_.isEmpty(sequence), sequence);
    type.children = children;
  }
  delete input[self.xsPrefix + 'sequence'];
  return type;
};

XsdSchema.prototype.parseSimpleType = function (input) {
  var self = this;

  var type = {};
  _.each(input[self.xsPrefix + 'simpleType'] || [], function (simpleType) {
    var typeValue = {};
    if (simpleType[self.xsPrefix + 'restriction']) {
      assert(simpleType[self.xsPrefix + 'restriction'].length === 1, simpleType[self.xsPrefix + 'restriction']);
      var restriction = simpleType[self.xsPrefix + 'restriction'][0];
      if (restriction.$.base !== 'anySimpleType') {
        typeValue.base = self.namespacedTypeName(restriction.$.base);
      }
      delete restriction.$;
      // We ignore the rest of the restriction because we do not care about restrictions on values, only elements and attributes
    }
    delete simpleType[self.xsPrefix + 'restriction'];
    if (simpleType[self.xsPrefix + 'union']) {
      assert(simpleType[self.xsPrefix + 'union'].length === 1, simpleType[self.xsPrefix + 'union']);
      var union = simpleType[self.xsPrefix + 'union'][0];
      typeValue.base = _.map(union.$.memberTypes.split(/\s+/), function (base) {
        return self.namespacedTypeName(base);
      });
      delete union.$.memberTypes;
      assert(_.isEmpty(union.$), union.$);
      delete union.$;
      assert(_.isEmpty(union), union);
    }
    delete simpleType[self.xsPrefix + 'union'];
    // TODO: Support other simple types
    assert(simpleType.$.name, simpleType.$);
    var typeName = self.namespacedName(simpleType.$.name);
    delete simpleType.$.name;
    assert(_.isEmpty(simpleType.$), simpleType.$);
    type[typeName] = typeValue;
  });
  delete input[self.xsPrefix + 'simpleType'];
  return type;
};

XsdSchema.prototype.parseTypes = function (input) {
  var self = this;

  var newTypes = {};
  _.each(input[self.xsPrefix + 'complexType'] || [], function (complexType) {
    var type = {};
    if (complexType[self.xsPrefix + 'sequence']) {
      _.extend(type, self.parseTypesSequence(complexType));
    }
    if (complexType[self.xsPrefix + 'choice']) {
      type.children = self.parseTypesChoice(complexType);
    }
    assert(!(complexType[self.xsPrefix + 'simpleContent'] && complexType[self.xsPrefix + 'complexContent']), complexType);
    _.each(['simpleContent', 'complexContent'], function (anyContent) {
      if (complexType[self.xsPrefix + anyContent]) {
        assert(complexType[self.xsPrefix + anyContent].length === 1, complexType[self.xsPrefix + anyContent]);
        _.each(['restriction', 'extension'], function (anyDerivation) {
          if (complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation]) {
            assert(complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation].length === 1, complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation]);
            if (complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0].$.base !== 'anyType') {
              type.base = self.namespacedTypeName(complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0].$.base);
              if (anyDerivation === 'restriction') {
                type.restriction = true;
              }
            }
            delete complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0].$.base;
            assert(_.isEmpty(complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0].$), complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0].$);
            delete complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0].$;
            if (complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0][self.xsPrefix + 'attribute']) {
              type.attributes = self.parseAttributes(complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0]);
            }
            if (complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0].sequence) {
              _.extend(type, self.parseTypesSequence(complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0]));
            }
            assert(_.isEmpty(complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0]), complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation][0]);
            delete complexType[self.xsPrefix + anyContent][0][self.xsPrefix + anyDerivation];
          }
        });
        assert(_.isEmpty(complexType[self.xsPrefix + anyContent][0]), complexType[self.xsPrefix + anyContent][0]);
      }
      delete complexType[self.xsPrefix + anyContent];
    });
    if (complexType[self.xsPrefix + 'attribute']) {
      type.attributes = self.parseAttributes(complexType);
    }

    assert(complexType.$.name, complexType.$);
    var typeName = self.namespacedName(complexType.$.name);
    delete complexType.$.name;
    assert(_.isEmpty(complexType.$), complexType.$);
    delete complexType.$;
    newTypes[typeName] = type;

    // We ignore annotations
    delete complexType[self.xsPrefix + 'annotation'];
  });
  delete input[self.xsPrefix + 'complexType'];

  _.extend(newTypes, self.parseSimpleType(input));

  // We ignore annotations and top-level attributes
  delete input[self.xsPrefix + 'annotation'];
  delete input.$;

  return newTypes;
};

XsdSchema.prototype.parseElements = function (input, isArrayDefault) {
  var self = this;

  var newElements = {};
  _.each(input[self.xsPrefix + 'element'] || [], function (element) {
    if (element.$.ref) {
      var elementReference = self.namespacedName(element.$.ref);
      newElements[elementReference] = {
        ref: elementReference
      };
      if (_.isBoolean(isArrayDefault)) {
        newElements[elementReference].isArrayDefault = isArrayDefault;
      }
    }
    else {
      assert(element.$.name, element.$);
      var elementName = self.namespacedName(element.$.name);
      var isArray = isArrayDefault;
      if (element.$.maxOccurs) {
        isArray = element.$.maxOccurs === 'unbounded' || parseInt(element.$.maxOccurs) > 1;
      }
      if (element.$.type) {
        newElements[elementName] = {
          type: self.namespacedTypeName(element.$.type)
        };
      }
      else {
        assert(element[self.xsPrefix + 'complexType'] || element[self.xsPrefix + 'simpleType'], element);
        assert(!(element[self.xsPrefix + 'complexType'] && element[self.xsPrefix + 'simpleType']), element);

        // Type is nested inside the element, so we create out own name for it
        var typeName = elementName + '-type-' + randomString();

        // Then we pretend that it is defined with out own name
        _.each(element[self.xsPrefix + 'complexType'] || [], function (complexType) {
          if (!complexType.$) complexType.$ = {};
          complexType.$.name = typeName;
        });
        _.each(element[self.xsPrefix + 'simpleType'] || [], function (simpleType) {
          if (!simpleType.$) simpleType.$ = {};
          simpleType.$.name = typeName;
        });

        // Parse it and store it
        var newTypes = self.parseTypes(element);
        _.extend(self.parser.types, newTypes);

        newElements[elementName] = {
          type: typeName
        };
      }
      if (_.isBoolean(isArray)) {
        newElements[elementName].isArray = isArray;
      }
    }
  });
  delete input[self.xsPrefix + 'element'];
  return newElements;
};

XsdSchema.prototype.parseAttributes = function (input) {
  var self = this;

  var newAttributes = {};
  _.each(input[self.xsPrefix + 'attribute'] || [], function (attribute) {
    if (attribute.$.ref) {
      var attributeReference = self.namespacedName(attribute.$.ref);
      newAttributes[attributeReference] = {
        ref: attributeReference
      };
    }
    else {
      assert(attribute.$.name, attribute.$);
      var attributeName = self.namespacedName(attribute.$.name);
      assert(!newAttributes[attributeName], newAttributes[attributeName]);
      if (attribute.$.type) {
        newAttributes[attributeName] = self.namespacedTypeName(attribute.$.type);
      }
      else if (attribute[self.xsPrefix + 'simpleType']) {
        // Type is nested inside the attribute, so we create out own name for it
        var typeName = attributeName + '-type-' + randomString();

        _.each(attribute[self.xsPrefix + 'simpleType'] || [], function (simpleType) {
          if (!simpleType.$) simpleType.$ = {};
          simpleType.$.name = typeName;
        });

        // Parse it and store it
        var newTypes = self.parseSimpleType(attribute);
        _.extend(self.parser.types, newTypes);

        newAttributes[attributeName] = typeName;
      }
      else {
        // Only simple types are allowed for attributes
        assert(false, attribute);
      }
      delete attribute.$;
      // We ignore annotations
      delete attribute[self.xsPrefix + 'annotation'];
      assert(_.isEmpty(attribute), attribute);
    }
  });
  delete input[self.xsPrefix + 'attribute'];
  return newAttributes;
};

XsdSchema.prototype.parseImportsAndIncludes = function (currentNamespaceUrl, schema) {
  var self = this;

  var imports = {};
  _.each(schema[self.xsPrefix + 'import'] || [], function (schemaImport) {
    multivalue.addValue(imports, schemaImport.$.namespace, schemaImport.$.schemaLocation);
  });
  delete schema[self.xsPrefix + 'import'];
  _.each(schema[self.xsPrefix + 'include'] || [], function (schemaInclude) {
    multivalue.addValue(imports, currentNamespaceUrl, schemaInclude.$.schemaLocation);
  });
  delete schema[self.xsPrefix + 'include'];
  return imports;
};

function parseNamespacePrefixes(namespacePrefixes, input, cb) {
  var xsPrefix = '';
  for (var element in input) {
    if (input.hasOwnProperty(element)) {
      var schema = input[element];
      if (schema.$) {
        for (var attr in schema.$) {
          if (schema.$.hasOwnProperty(attr)) {
            if (attr.slice(0, 6) === 'xmlns:') {
              var value = schema.$[attr];
              var namespace = attr.slice(6);
              if (!namespace) {
                cb("Invalid namespace declaration: " + attr + ", for schema: " + util.inspect(schema, false, null));
                return;
              }
              // We process XML Schema namespace specially because we normalize it by removing any prefix
              else if (value === 'http://www.w3.org/2001/XMLSchema') {
                assert(xsPrefix === '', xsPrefix);
                // We add : and call it "prefix" so that we can use it by simple string concatenation
                xsPrefix = namespace + ':';
              }
              else if (namespacePrefixes[value] && namespacePrefixes[value] !== namespace) {
                // TODO: We should not use prefixes for schema, but URIs and do not care what prefixes are, and then when validating again use URIs directly
                cb("Conflicting namespace declaration: " + namespacePrefixes[value] + " vs. " + namespace + ", for schema: " + util.inspect(schema, false, null));
                return;
              }
              else {
                namespacePrefixes[value] = namespace;
              }
            }
          }
        }
      }
    }
  }
  cb(null, xsPrefix);
}

function traverseFindSchemas(obj) {
  var foundSchemas = {};
  _.each(obj, function (o, tag) {
    if (tag !== '$') {
      if (_.isObject(o)) {
        _.extend(foundSchemas, traverseFindSchemas(o));
      }
    }
    else {
      // TODO: xsi prefix should probably not be hard-coded
      if (o['xsi:schemaLocation']) {
        var schemaLocation = o['xsi:schemaLocation'].split(/\s+/);
        assert(schemaLocation.length === 2, schemaLocation);
        multivalue.addValue(foundSchemas, schemaLocation[0], schemaLocation[1]);
      }
    }
  });
  return foundSchemas;
}

var XsdMixin = {
  // Returns imports (and includes) object in a callback. You have assure that
  // all those schemas are added as well for all necessary types to be satisfied.
  addSchema: function (namespaceUrl, schemaContent, cb) {
    var self = this;

    if (multivalue.hasValue(self.parsedSchemas, namespaceUrl, schemaContent)) {
      cb(null, {});
      return;
    }

    xml2js.parseString(schemaContent, function (err, result) {
      if (err) {
        cb(err);
        return;
      }

      // Only one root element expected
      if (!result || _.size(result) !== 1) {
        cb("Invalid schema for " + namespaceUrl + ": " + util.inspect(result, false, null));
        return;
      }

      parseNamespacePrefixes(self.namespacePrefixes, result, function (err, xsPrefix) {
        if (err) {
          cb(err);
          return;
        }

        assert(result[xsPrefix + 'schema'], result);

        var schema = result[xsPrefix + 'schema'];

        if (!schema.$ || schema.$.targetNamespace !== namespaceUrl) {
          cb("Invalid schema for " + namespaceUrl + ": " + util.inspect(result, false, null));
          return;
        }

        var namespace = self.namespacePrefixes[namespaceUrl];
        if (!namespace) {
          cb("Could not determine namespace for schema " + namespaceUrl + ", known namespace prefixes: " + util.inspect(self.namespacePrefixes, false, null));
          return;
        }

        var schemaParser = new XsdSchema(self, namespace, xsPrefix);

        var importsAndIncludes = schemaParser.parseImportsAndIncludes(namespaceUrl, schema);

        var newElements = schemaParser.parseElements(schema, null);
        // TODO: Check if we are overriding anything
        _.extend(self.elements, newElements);

        var newAttributes = schemaParser.parseAttributes(schema);
        // TODO: Check if we are overriding anything
        _.extend(self.attributes, newAttributes);

        var newTypes = schemaParser.parseTypes(schema);
        // TODO: Check if we are overriding anything
        _.extend(self.types, newTypes);

        // TODO: Add support for element and attribute groups
        delete schema[xsPrefix + 'group'];
        delete schema[xsPrefix + 'attributeGroup'];

        // Previous parsing calls are destructive and should consume schema so that it is empty now
        assert(_.isEmpty(schema), schema);

        multivalue.addValue(self.parsedSchemas, namespaceUrl, schemaContent);

        cb(null, importsAndIncludes);
      });
    });
  },

  // Returns imports (and includes) object in a callback. You have assure that
  // all those schemas are added as well for all necessary types to be satisfied.
  downloadAndAddSchema: function (namespaceUrl, schemaUrl, cb) {
    var self = this;

    if (multivalue.hasValue(self.downloadedSchemas, namespaceUrl, schemaUrl)) {
      cb(null, {});
      return;
    }

    request(schemaUrl, function (err, response, body) {
      if (err) {
        cb("Error downloading " + namespaceUrl + " schema (" + schemaUrl + "): " + err);
        return;
      }
      else if (response.statusCode !== 200) {
        cb("Error downloading " + namespaceUrl + " schema (" + schemaUrl + "): HTTP status code " + response.statusCode);
        return;
      }

      self.addSchema(namespaceUrl, body, function (err, importsAndIncludes) {
        if (err) {
          cb(err);
          return;
        }

        multivalue.addValue(self.downloadedSchemas, namespaceUrl, schemaUrl);

        cb(null, importsAndIncludes);
      });
    });
  },

  // Does not search recursively inside schemas for imported other
  // schemas, so there might still be types missing when parsing,
  // even if you satisfy all found schemas. You have to inspect
  // pending imports returned in a callback of addSchema (or
  // downloadAndAddSchema) and satisfy those schemas as well.
  findSchemas: function (str, cb) {
    var self = this;

    xml2js.parseString(str, function (err, result) {
      if (err) {
        cb(err);
        return;
      }

      var foundSchemas = traverseFindSchemas(result);
      cb(null, foundSchemas);
    });
  },

  knownSchemas: function () {
    var self = this;

    return _.clone(self.parsedSchemas);
  }
};

exports.BASE_NAMESPACES = BASE_NAMESPACES;
exports.BASE_TYPES = BASE_TYPES;
exports.XsdMixin = XsdMixin;
