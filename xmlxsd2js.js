var assertBase = require('assert');
var async = require('async');
var crypto = require('crypto');
var moment = require('moment');
var request = require('request');
var util = require('util');
var xml2js = require('xml2js');
var _ = require('underscore');

var parsedSchemas = {};
var downloadedSchemas = {};
var types = {};
var baseAttributes = {};
var baseElements = {};
var namespacePrefixes = {
  // Bound by definition
  'http://www.w3.org/XML/1998/namespace': 'xml'
};

function assert(condition, message) {
  if (!condition) {
    if (_.isObject(message)) {
      message = util.inspect(message, false, null);
    }
    assertBase(false, message);
  }
}

// XML Schema names are the only one without a prefix, we remove everywhere xs:

types.string = types.normalizedString = types.token = types.language = types.NMTOKEN = types.Name = types.NCName = types.ID = types.IDREF = types.ENTITY = {
  parse: function (value) {
    return value;
  }
};

types.NMTOKENS = types.IDREFS = types.ENTITIES = {
  parse: function (value) {
    return value.split(/\s+/);
  }
};

types.boolean = {
  parse: function (value) {
    return _.contains(['true', 'false', '0', '1'], value.toLowerCase());
  }
};

types.integer = types.nonPositiveInteger = types.negativeInteger = types.long = types.int = types.short = types.byte = types.nonNegativeInteger = types.unsignedLong = types.unsignedInt = types.unsignedShort = types.unsignedByte = types.positiveInteger = {
  parse: function (value) {
    return parseInt(value);
  }
};

types.decimal = {
  parse: function (value) {
    return parseFloat(value);
  }
};

types.double = types.float = {
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

// duration not implemented

types.dateTime = types.date = {
  parse: function (value) {
    return moment.utc(value).toDate();
  }
};

// time not implemented

// gYearMonth, gYear, gMonthDay, gDay, gMonth not implemented

types.hexBinary = {
  parse: function (value) {
    return new Buffer(value, 'hex');
  }
};

types.base64Binary = {
  parse: function (value) {
    return new Buffer(value, 'base64');
  }
};

types.anyURI = {
  parse: function (value) {
    return value;
  }
};

// QName, NOTATION not implemented

var XS_TYPES = _.keys(types);

function resolveType(xpath, typeName) {
  if (!types[typeName]) {
    throw new xml2js.ValidationError("Type " + typeName + " not found, xpath: " + xpath + ", known types: " + util.inspect(types, false, null));
  }
  else if (types[typeName].content && types[typeName].content.base) {
    if (_.isArray(types[typeName].content.base)) {
      var res = [];
      _.each(types[typeName].content.base, function (base) {
        res = res.concat(resolveType(xpath, base));
      });
      return res;
    }
    else {
      return resolveType(xpath, types[typeName].content.base);
    }
  }
  else {
    return [types[typeName]];
  }
}

function resolveAttributeType(xpath, typeName) {
  while (_.isObject(typeName)) {
    assert(typeName.ref, typeName);
    if (!baseAttributes[typeName.ref]) {
      throw new xml2js.ValidationError("Referenced attribute " + typeName.ref + " not found, xpath: " + xpath + ", known attributes: " + util.inspect(baseAttributes, false, null));
    }
    typeName = baseAttributes[typeName.ref];
  }
  return typeName;
}

function resolveElement(xpath, element) {
  var isArrayDefault = null;
  while (element.ref) {
    if (!baseElements[element.ref]) {
      throw new xml2js.ValidationError("Referenced element " + element.ref + " not found, xpath: " + xpath + ", known attributes: " + util.inspect(baseElements, false, null));
    }
    if (_.has(element, 'isArrayDefault')) {
      isArrayDefault = element.isArrayDefault;
    }
    element = baseElements[element.ref];
  }
  if (_.has(element, 'isArray')) {
    assert(_.isBoolean(element.isArray), element);
  }
  else if (_.isBoolean(isArrayDefault)) {
    element = _.clone(element);
    element.isArray = isArrayDefault;
  }
  return element;
}

function resolveToParse(xpath, typeName) {
  if (!types[typeName]) {
    throw new xml2js.ValidationError("Type " + typeName + " not found, xpath: " + xpath + ", known types: " + util.inspect(types, false, null));
  }
  else if (types[typeName].parse) {
    return [types[typeName].parse];
  }
  else if (types[typeName].content && types[typeName].content.base) {
    if (_.isArray(types[typeName].content.base)) {
      var res = [];
      _.each(types[typeName].content.base, function (base) {
        res = res.concat(resolveToParse(xpath, base));
      });
      return res;
    }
    else {
      return resolveToParse(xpath, types[typeName].content.base);
    }
  }
  else {
    return [];
  }
}

function tryParse(parse, value) {
  var exception = null;
  for (var i = 0; i < parse.length; i++) {
    try {
      return parse[0](value);
    }
    catch (e) {
      exception = e;
    }
  }
  assert(exception);
  throw exception;
}

function tryChildren(xpath, type) {
  for (var i = 0; i < type.length; i++) {
    if (type[i].anyChildren) {
      return baseElements;
    }
    else if (type[i].children) {
      return type[i].children;
    }
  }
  throw new xml2js.ValidationError("Type does not expect children, xpath: " + xpath + ", type: " + util.inspect(type, false, null));
}

function tryRemoveArrays(xpath, attrkey, charkey, xmlnskey, namespace, type, newValue) {
  var exception = null;
  for (var i = 0; i < type.length; i++) {
    var value = _.clone(newValue);
    try {
      if (type[i].anyChildren) {
        // TODO: Currently we support only one "any" element at the time (it can have multiple entries, but they have to be same "any" tag). Can there be multiple "any" elements defined?
        assert(_.size(value) === 1, value);
        _.each(value, function (child, name) {
          if (name === attrkey || name === charkey || name === xmlnskey) {
            // Attribute, character content, and namespace keys are not part of the schema
            return;
          }
          if (!type[i].isArray) {
            assert(child.length === 1, child);
            value[name] = child[0];
          }
        });
      }
      else if (type[i].children) {
        _.each(value, function (child, name) {
          if (name === attrkey || name === charkey || name === xmlnskey) {
            // Attribute, character content, and namespace keys are not part of the schema
            return;
          }
          var childName = namespacedName(namespace, name);
          if (!type[i].children[childName]) {
            throw new xml2js.ValidationError("Element (" + childName + ") does not match schema, xpath: " + xpath + ", allowed elements: " + util.inspect(type[i].children, false, null));
          }
          else if (!resolveElement(xpath, type[i].children[childName]).isArray) {
            assert(child.length === 1, child);
            value[name] = child[0];
          }
        });
      }
      else {
        throw new xml2js.ValidationError("Type does not expect children, xpath: " + xpath + ", type: " + util.inspect(type[i], false, null));
      }
      return value;
    }
    catch (e) {
      exception = e;
    }
  }
  assert(exception);
  throw exception;
}

function resolveToAttributes(xpath, typeName) {
  if (!types[typeName]) {
    throw new xml2js.ValidationError("Type " + typeName + " not found, xpath: " + xpath + ", known types: " + util.inspect(types, false, null));
  }
  else if (types[typeName].content && types[typeName].content.attributes) {
    return types[typeName].content.attributes;
  }
  else {
    return {};
  }
}

function nodeNamespace(xmlnskey, node) {
  assert(node[xmlnskey].uri, node);
  if (!namespacePrefixes[node[xmlnskey].uri]) {
    throw new xml2js.ValidationError("Unknown namespace " + node[xmlnskey].uri + ", element: " + util.inspect(node, false, null));
  }
  return namespacePrefixes[node[xmlnskey].uri];
}

function createNamespacedPath(xmlnskey, stack, xpath, newValue) {
  var path = [];
  _.each(stack, function (node) {
    var namespace = nodeNamespace(xmlnskey, node);
    path.push(namespacedName(namespace, node['#name']));
  });
  // We get the name of the last node from the last element of the xpath
  var splitXpath = xpath.split('/');
  path.push(namespacedName(nodeNamespace(xmlnskey, newValue), splitXpath[splitXpath.length - 1]));
  return path;
}

function validator(xpath, currentValue, newValue, stack) {
  var attrkey = this.attrkey;
  var charkey = this.charkey;
  var xmlnskey = this.xmlnskey;

  // TODO: Make configurable
  var outputWithNamespace = false;

  var path = createNamespacedPath(xmlnskey, stack, xpath, newValue);
  // We override given xpath with namespaced xpath
  xpath = '/' + path.join('/');

  var namespace = nodeNamespace(xmlnskey, newValue);

  var currentElementSet = baseElements;

  _.each(path.slice(0, path.length - 1), function (segment) {
    if (!currentElementSet[segment]) {
      throw new xml2js.ValidationError("Element (" + segment + ") does not match schema, xpath: " + xpath + ", allowed elements: " + util.inspect(currentElementSet, false, null));
    }
    else if (!resolveElement(xpath, currentElementSet[segment]).type) {
      throw new xml2js.ValidationError("Element (" + segment + ") does not match schema, type not specified, xpath: " + xpath + ", element: " + util.inspect(currentElementSet[segment], false, null));
    }
    else {
      var type = resolveType(xpath, resolveElement(xpath, currentElementSet[segment]).type);
      currentElementSet = tryChildren(xpath, type);
    }
  });

  var lastSegment = path[path.length - 1];

  // TODO: Do tests with all possible OAI types and XML examples, download them, cache them

  if (!currentElementSet[lastSegment]) {
    throw new xml2js.ValidationError("Element (" + lastSegment + ") does not match schema, xpath: " + xpath + ", allowed elements: " + util.inspect(currentElementSet, false, null));
  }

  var lastSegmentType = resolveElement(xpath, currentElementSet[lastSegment]).type;

  if (newValue[attrkey]) {
    var attributes = resolveToAttributes(xpath, lastSegmentType);
    _.each(newValue[attrkey], function (value, attribute) {
      var attributeName = namespacedName(namespace, attribute);
      if (attribute.slice(0, 5) === 'xmlns') {
        delete newValue[attrkey][attribute];
      }
      else if (attribute.slice(0, 4) === 'xsi:') {
        delete newValue[attrkey][attribute];
      }
      else if (!attributes[attributeName]) {
        throw new xml2js.ValidationError("Unexpected attribute " + attributeName + ", xpath: " + xpath + ", allowed attributes: " + util.inspect(attributes, false, null))
      }
      else {
        var parse = resolveToParse(xpath, resolveAttributeType(xpath,attributes[attributeName]));
        if (_.isString(value)) {
          delete newValue[attrkey][attribute];
          newValue[attrkey][namespacedOrNotName(namespace, attribute, outputWithNamespace)] = tryParse(parse, value);
        }
        else if (value.value) {
          // TODO: What if user wants namespace information, we should not replace with only the value in that case
          delete newValue[attrkey][attribute];
          newValue[attrkey][namespacedOrNotName(namespace, attribute, outputWithNamespace)] = tryParse(parse, value.value);
        }
        else {
          throw new xml2js.ValidationError("Invalid attribute " + attributeName + " value, xpath: " + xpath + ": " + util.inspect(value, false, null))
        }
      }
    });
    if (_.isEmpty(newValue[attrkey])) {
      delete newValue[attrkey];
    }
  }

  // Delete namespace key
  // TODO: What if user wants it? We should make this optional (code below already supports it)
  delete newValue[xmlnskey];

  var parse = resolveToParse(xpath, lastSegmentType);
  if (parse.length !== 0) {
    // If it is string, we can try to parse it
    if (_.isString(newValue)) {
      newValue = tryParse(parse, newValue);
    }
    // If there is object with only character value, we can parse it and replace whole value with it
    else if (_.isEmpty(_.without(_.keys(newValue), charkey)) && newValue[charkey]) {
      newValue = tryParse(parse, newValue[charkey]);
    }
    // It might be an object with some attributes together with character value, then we just parse the value itself
    else if (_.isEmpty(_.without(_.keys(newValue), charkey, attrkey, xmlnskey)) && newValue[charkey]) {
      newValue[charkey] = tryParse(parse, newValue[charkey]);
    }
    // But any additional keys should not be there
    else {
      throw new xml2js.ValidationError("Element (" + lastSegment + ") does not match schema, xpath: " + xpath + ", expected value, got : " + util.inspect(newValue, false, null));
    }
  }
  else {
    var type = resolveType(xpath, lastSegmentType);
    newValue = tryRemoveArrays(xpath, attrkey, charkey, xmlnskey, namespace, type, newValue);
    normalizeNamespaces(attrkey, charkey, xmlnskey, namespace, newValue, outputWithNamespace);
  }

  return newValue;
}

function randomString() {
  return crypto.pseudoRandomBytes(10).toString('hex');
}

function namespacedName(namespace, name) {
  assert(namespace);
  assert(name);
  // XML Schema names are the only one without a prefix, we remove everywhere xs:
  if (/^xs:/.test(name)) {
    return name.slice(3);
  }
  else if (/:/.test(name)) {
    return name;
  }
  else {
    return namespace + ':' + name;
  }
}

function namespacedOrNotName(namespace, name, namespaced) {
  if (namespaced) {
    return namespacedName(namespace, name);
  }
  else {
    return name.replace(/^[^:]+:/, '');
  }
}

function normalizeNamespaces(attrkey, charkey, xmlnskey, namespace, value, namespaced) {
  _.each(value, function (val, key) {
    if (key === attrkey || key === charkey || key === xmlnskey) {
      // Ignoring attribute, character content, and namespace keys
      return;
    }
    delete value[key];
    value[namespacedOrNotName(namespace, key, namespaced)] = val;
  });
}

function namespacedTypeName(namespace, name) {
  assert(namespace);
  assert(name);
  // We do not prefix XML Schema defined types
  if (_.indexOf(XS_TYPES, name) !== -1) {
    return name
  }
  else {
    return namespacedName(namespace, name);
  }
}

function parseTypesElement(namespace, element, isArrayDefault) {
  var result = {};
  if (element.$.ref) {
    var elementReference = namespacedName(namespace, element.$.ref);
    result[elementReference] = {
      ref: elementReference
    };
    if (_.isBoolean(isArrayDefault)) {
      result[elementReference].isArrayDefault = isArrayDefault;
    }
  }
  else {
    assert(element.$.name, element.$);
    var elementName = namespacedName(namespace, element.$.name);
    var isArray = isArrayDefault;
    if (element.$.maxOccurs) {
      isArray = element.$.maxOccurs === 'unbounded' || parseInt(element.$.maxOccurs) > 1;
    }
    result[elementName] = {
      type: namespacedTypeName(namespace, element.$.type)
    };
    if (_.isBoolean(isArray)) {
      result[elementName].isArray = isArray;
    }
  }
  return result;
}

function parseTypesAttribute(namespace, attribute) {
  var result = {};
  if (attribute.$.ref) {
    var attributeReference = namespacedName(namespace, attribute.$.ref);
    result[attributeReference] = {
      ref: attributeReference
    };
  }
  else {
    assert(attribute.$.name, attribute.$);
    var attributeName = namespacedName(namespace, attribute.$.name);
    assert(!result[attributeName], result[attributeName]);
    if (attribute.$.type) {
      result[attributeName] = namespacedTypeName(namespace, attribute.$.type);
    }
    else if (attribute.simpleType) {
      // Type is nested inside the attribute, so we create out own name for it
      var typeName = attributeName + '-type-' + randomString();

      _.each(attribute.simpleType || [], function (simpleType) {
        if (!simpleType.$) simpleType.$ = {};
        simpleType.$.name = typeName;
      });

      // Parse it and store it
      var newTypes = parseSimpleType(namespace, attribute);
      _.extend(types, newTypes);

      result[attributeName] = typeName;
    }
    else {
      // Only simple types are allowed for attributes
      assert(false, attribute);
    }
    delete attribute.$;
    // We ignore annotations
    delete attribute.annotation;
    assert(_.isEmpty(attribute), attribute);
  }
  return result;
}

function parseTypesChoice(namespace, input) {
  assert(input.choice, input);
  var children = {};
  assert(input.choice.length === 1, input.choice);
  var isArrayDefault = null;
  if (input.choice[0].$) {
    if (input.choice[0].$.maxOccurs) {
      isArrayDefault = input.choice[0].$.maxOccurs === 'unbounded' || parseInt(input.choice[0].$.maxOccurs) > 1;
    }
    delete input.choice[0].$.minOccurs;
    delete input.choice[0].$.maxOccurs;
    assert(_.isEmpty(input.choice[0].$), input.choice[0].$);
  }
  delete input.choice[0].$;
  _.each(input.choice[0].element || [], function (element) {
    _.extend(children, parseTypesElement(namespace, element, isArrayDefault));
  });
  delete input.choice[0].element;
  assert(_.isEmpty(input.choice[0]), input.choice[0]);
  delete input.choice;
  return children;
}

function parseSimpleType(namespace, input) {
  var result = {};
  _.each(input.simpleType || [], function (simpleType) {
    var type = {};
    assert(!(simpleType.restriction && simpleType.union), simpleType);
    if (simpleType.restriction) {
      var content = {};
      assert(simpleType.restriction.length === 1, simpleType.restriction);
      content.base = namespacedTypeName(namespace, simpleType.restriction[0].$.base);
      delete simpleType.restriction[0].$.base;
      assert(_.isEmpty(simpleType.restriction[0].$), simpleType.restriction[0].$);
      delete simpleType.restriction[0].$;
      // We ignore the pattern and enumeration
      delete simpleType.restriction[0].pattern;
      delete simpleType.restriction[0].enumeration;
      assert(_.isEmpty(simpleType.restriction[0]), simpleType.restriction[0]);
      type.content = content;
    }
    delete simpleType.restriction;
    if (simpleType.union) {
      var content = {};
      assert(simpleType.union.length === 1, simpleType.union);
      content.base = _.map(simpleType.union[0].$.memberTypes.split(/\s+/), function (base) {
        return namespacedTypeName(namespace, base);
      });
      delete simpleType.union[0].$.memberTypes;
      assert(_.isEmpty(simpleType.union[0].$), simpleType.union[0].$);
      delete simpleType.union[0].$;
      assert(_.isEmpty(simpleType.union[0]), simpleType.union[0]);
      type.content = content;
    }
    delete simpleType.union;

    assert(simpleType.$.name, simpleType.$);
    var typeName = namespacedName(namespace, simpleType.$.name);
    delete simpleType.$.name;
    assert(_.isEmpty(simpleType.$), simpleType.$);
    result[typeName] = type;
  });
  delete input.simpleType;
  return result;
}

function parseTypes(namespace, schema) {
  var newTypes = {};
  _.each(schema.complexType || [], function (complexType) {
    var type = {};
    if (complexType.sequence) {
      var children = {};
      assert(complexType.sequence.length === 1, complexType.sequence);
      var isArrayDefault = null;
      if (complexType.sequence[0].$) {
        if (complexType.sequence[0].$.maxOccurs) {
          isArrayDefault = complexType.sequence[0].$.maxOccurs === 'unbounded' || parseInt(complexType.sequence[0].$.maxOccurs) > 1;
        }
        delete complexType.sequence[0].$.minOccurs;
        delete complexType.sequence[0].$.maxOccurs;
        assert(_.isEmpty(complexType.sequence[0].$), complexType.sequence[0].$);
      }
      delete complexType.sequence[0].$;
      _.each(complexType.sequence[0].element || [], function (element) {
        _.extend(children, parseTypesElement(namespace, element, isArrayDefault));
      });
      delete complexType.sequence[0].element;
      if (complexType.sequence[0].choice) {
        _.extend(children, parseTypesChoice(namespace, complexType.sequence[0]));
      }
      if (complexType.sequence[0].any) {
        assert(complexType.sequence[0].any.length === 1, complexType.sequence[0].any);
        type.anyChildren = true;
        var isArray = isArrayDefault;
        if (complexType.sequence[0].any[0].$.maxOccurs) {
          isArray = complexType.sequence[0].any[0].$.maxOccurs === 'unbounded' || parseInt(complexType.sequence[0].any[0].$.maxOccurs) > 1;
        }
        if (_.isBoolean(isArray)) {
          type.isArray = isArray;
        }
      }
      delete complexType.sequence[0].any;
      assert(_.isEmpty(complexType.sequence[0]), complexType.sequence[0]);
      type.children = children;
    }
    delete complexType.sequence;
    if (complexType.choice) {
      type.children = parseTypesChoice(namespace, complexType);
    }
    assert(!(complexType.simpleContent && complexType.complexContent), complexType);
    _.each(['simpleContent', 'complexContent'], function (anyContent) {
      if (complexType[anyContent]) {
        var content = {};
        assert(complexType[anyContent].length === 1, complexType[anyContent]);
        assert(complexType[anyContent][0].extension.length === 1, complexType[anyContent][0].extension);
        content.base = namespacedTypeName(namespace, complexType[anyContent][0].extension[0].$.base);
        delete complexType[anyContent][0].extension[0].$.base;
        assert(_.isEmpty(complexType[anyContent][0].extension[0].$), complexType[anyContent][0].extension[0].$);
        delete complexType[anyContent][0].extension[0].$;
        if (complexType[anyContent][0].extension[0].attribute) {
          var attributes = {};
          _.each(complexType[anyContent][0].extension[0].attribute, function (attribute) {
            _.extend(attributes, parseTypesAttribute(namespace, attribute));
          });
          content.attributes = attributes;
        }
        delete complexType[anyContent][0].extension[0].attribute;
        assert(_.isEmpty(complexType[anyContent][0].extension[0]), complexType[anyContent][0].extension[0]);
        type.content = content;
      }
      delete complexType[anyContent];
    });
    if (complexType.attribute) {
      var attributes = {};
      _.each(complexType.attribute, function (attribute) {
        _.extend(attributes, parseTypesAttribute(namespace, attribute));
      });
      type.attributes = attributes;
    }
    delete complexType.attribute;

    assert(complexType.$.name, complexType.$);
    var typeName = namespacedName(namespace, complexType.$.name);
    delete complexType.$.name;
    assert(_.isEmpty(complexType.$), complexType.$);
    delete complexType.$;
    newTypes[typeName] = type;

    // We ignore annotations
    delete complexType.annotation;
  });
  delete schema.complexType;

  _.extend(newTypes, parseSimpleType(namespace, schema));

  // We ignore annotations and top-level attributes
  delete schema.annotation;
  delete schema.$;

  return newTypes;
}

function parseElements(namespace, schema) {
  _.each(schema.element || [], function (element) {
    assert(element.$.name, element.$);
    var elementName = namespacedName(namespace, element.$.name);
    var isArray = null;
    if (element.$.maxOccurs) {
      isArray = element.$.maxOccurs === 'unbounded' || parseInt(element.$.maxOccurs) > 1;
    }
    if (element.$.type) {
      assert(!baseElements[elementName], baseElements[elementName]);
      baseElements[elementName] = {
        type: namespacedTypeName(namespace, element.$.type)
      };
    }
    else {
      assert(element.complexType || element.simpleType, element);
      assert(!(element.complexType && element.simpleType), element);

      // Type is nested inside the element, so we create out own name for it
      var typeName = elementName + '-type-' + randomString();

      // Then we pretend that it is defined with out own name
      _.each(element.complexType || [], function (complexType) {
        if (!complexType.$) complexType.$ = {};
        complexType.$.name = typeName;
      });
      _.each(element.simpleType || [], function (simpleType) {
        if (!simpleType.$) simpleType.$ = {};
        simpleType.$.name = typeName;
      });

      // Parse it and store it
      var newTypes = parseTypes(namespace, element);
      _.extend(types, newTypes);

      assert(!baseElements[elementName], baseElements[elementName]);
      baseElements[elementName] = {
        type: typeName
      };
    }
    if (_.isBoolean(isArray)) {
      baseElements[elementName].isArray = isArray;
    }
  });
  delete schema.element;
}

function parseAttributes(namespace, schema) {
  _.each(schema.attribute || [], function (attribute) {
    var newAttributes = parseTypesAttribute(namespace, attribute);
    _.each(newAttributes, function (type, attrName) {
      assert(!baseAttributes[attrName], baseAttributes[attrName]);
      baseAttributes[attrName] = type;
    });
  });
  delete schema.attribute;
}

function parseImports(schema) {
  var pendingImports = {};
  _.each(schema.import || [], function (schemaImport) {
    if (!parsedSchemas[schemaImport.$.namespace]) {
      pendingImports[schemaImport.$.namespace] = schemaImport.$.schemaLocation;
    }
  });
  delete schema.import;
  return pendingImports;
}

function parseNamespacePrefixes(schema, cb) {
  for (var attr in schema.$) {
    if (schema.$.hasOwnProperty(attr)) {
      if (attr.slice(0, 6) === 'xmlns:') {
        var value = schema.$[attr];
        var namespace = attr.slice(6);
        if (!namespace) {
          cb("Invalid namespace declaration: " + attr + ", for schema: " + util.inspect(schema, false, null));
          return;
        }
        else if (namespacePrefixes[value] && namespacePrefixes[value] !== namespace) {
          cb("Conflicting namespace declaration: " + namespacePrefixes[value] + " vs. " + namespace + ", for schema: " + util.inspect(schema, false, null));
          return;
        }
        else {
          namespacePrefixes[value] = namespace;
        }
      }
    }
  }
  cb();
}

// Returns pending imports object in a callback. Those schemas have
// to be added as well for all necessary types to be satisfied.
function addSchema(namespaceUrl, schemaContent, cb) {
  if (parsedSchemas[namespaceUrl]) {
    cb();
    return;
  }

  xml2js.parseString(schemaContent, {
    tagNameProcessors: [function(str) {
      // XML Schema names are the only one without a prefix, we remove everywhere xs:
      return str.replace(/^xs:/, '');
    }]
  }, function (err, result) {
    if (err) {
      cb(err);
      return;
    }

    if (!result || !result.schema || !result.schema.$ || result.schema.$.targetNamespace !== namespaceUrl) {
      cb("Invalid schema for " + namespaceUrl + ": " + util.inspect(result, false, null));
      return;
    }

    var schema = result.schema;

    parseNamespacePrefixes(schema, function (err) {
      if (err) {
        cb(err);
        return;
      }

      var namespace = namespacePrefixes[namespaceUrl];
      if (!namespace) {
        cb("Could not determine namespace for schema " + namespaceUrl + ", known namespace prefixes: " + util.inspect(namespacePrefixes, false, null));
        return;
      }

      var pendingImports = parseImports(schema);

      parseElements(namespace, schema);
      parseAttributes(namespace, schema);

      var newTypes = parseTypes(namespace, schema);
      _.extend(types, newTypes);

      // TODO: Add support for element and attribute groups
      delete schema.group;
      delete schema.attributeGroup;

      // Previous parsing calls are destructive and should consume schema so that it is empty now
      assert(_.isEmpty(schema), schema);

      parsedSchemas[namespaceUrl] = schemaContent;
      // We set it again, just to assure we are in sync
      downloadedSchemas[namespaceUrl] = schemaContent;

      cb(null, pendingImports);
    });
  });
}

// Returns pending imports object in a callback. Those schemas have
// to be added as well for all necessary types to be satisfied.
function downloadAndAddSchema(namespaceUrl, schemaUrl, cb) {
  if (parsedSchemas[namespaceUrl]) {
    cb();
    return;
  }

  if (downloadedSchemas[namespaceUrl]) {
    addSchema(namespaceUrl, downloadedSchemas[namespaceUrl], cb);
  }
  else {
    request(schemaUrl, function (err, response, body) {
      if (err) {
        cb("Error downloading " + namespaceUrl + " schema (" + schemaUrl + "): " + err);
        return;
      }
      else if (response.statusCode !== 200) {
        cb("Error downloading " + namespaceUrl + " schema (" + schemaUrl + "): HTTP status code " + response.statusCode);
        return;
      }

      downloadedSchemas[namespaceUrl] = body;

      addSchema(namespaceUrl, body, cb);
    });
  }
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
      if (o['xsi:schemaLocation']) {
        var schemaLocation = o['xsi:schemaLocation'].split(/\s+/);
        assert(schemaLocation.length === 2, schemaLocation);
        foundSchemas[schemaLocation[0]] = schemaLocation[1];
      }
    }
  });
  return foundSchemas;
}

// Does not search recursively inside schemas for imported other
// schemas, so there might still be types missing when parsing,
// even if you satisfy all found schemas. You have to inspect
// pending imports returned in a callback of addSchema (or
// downloadAndAddSchema) and satisfy those schemas as well.
function findSchemas(str, cb) {
  xml2js.parseString(str, function (err, result) {
    if (err) {
      cb(err);
      return;
    }

    var foundSchemas = traverseFindSchemas(result);
    cb(null, foundSchemas);
  });
}

function populateSchemas(str, options, cb) {
  findSchemas(str, function (err, foundSchemas) {
    if (err) {
      cb(err);
      return;
    }

    if (options.downloadSchemas) {
      // We do breadth-first traversal of schemas to prevent possible infinite loops
      async.until(function () {
        return _.isEmpty(foundSchemas);
      }, function (cb) {
        async.each(_.keys(foundSchemas), function (namespaceUrl, cb) {
          downloadAndAddSchema(namespaceUrl, foundSchemas[namespaceUrl], function (err, pendingImports) {
            if (err) {
              cb(err);
              return;
            }

            _.each(pendingImports, function (pendingSchemaUrl, pendingNamespaceUrl) {
              if (foundSchemas[pendingNamespaceUrl]) {
                if (foundSchemas[pendingNamespaceUrl] !== pendingSchemaUrl) {
                  throw new Error("Mismatched schema locations for " + pendingNamespaceUrl + ": " + foundSchemas[pendingNamespaceUrl] + " vs. " + pendingSchemaUrl);
                }
              }
              else {
                foundSchemas[pendingNamespaceUrl] = pendingSchemaUrl;
              }
            });

            // We just processed this one, so we can remove it
            delete foundSchemas[namespaceUrl];

            cb();
          });
        }, cb);
      }, cb);
    }
    else {
      for (var namespaceUrl in foundSchemas) {
        if (foundSchemas.hasOwnProperty(namespaceUrl)) {
          if (!parsedSchemas[namespaceUrl]) {
            cb("Schema " + namespaceUrl + " (" + foundSchemas[namespaceUrl] + ") unavailable and automatic downloading not enabled");
            return;
          }
        }
      }
      // All schemas used in the document are available, good (there could still be some imported ones missing)
      cb();
    }
  });
}

function knownSchemas() {
  return _.clone(parsedSchemas);
}

function parseString(str, a, b) {
  var cb, options, parser;
  if (b != null) {
    if (typeof b === 'function') {
      cb = b;
    }
    if (typeof a === 'object') {
      options = a;
    }
  }
  else {
    if (typeof a === 'function') {
      cb = a;
    }
    options = {};
  }
  options = _.defaults(options, {
    // Should we automatically download, parse and add any found missing schemas?
    // Will do Internet queries and could potentially leak information about what
    // type of documents you are parsing. Will cache schemas, so they will not be
    // redownloaded for every document parsed with the same instance of this module.
    // Consider setting this to false and adding schemas yourself with addSchema.
    downloadSchemas: false
  });
  populateSchemas(str, options, function (err) {
    if (err) {
      cb(err);
      return;
    }

    options.explicitRoot = true;
    options.explicitArray = true;
    options.xmlns = true;
    options.validator = validator;
    parser = new xml2js.Parser(options);
    parser.parseString(str, cb);
  });
}

exports.validator = validator;
exports.addSchema = addSchema;
exports.downloadAndAddSchema = downloadAndAddSchema;
exports.findSchemas = findSchemas;
exports.knownSchemas = knownSchemas;
exports.parseString = parseString;
