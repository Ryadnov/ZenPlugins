var g_baseurl =  'https://mobile.vtb24.ru/', //"https://online.vtb24.ru/"
	g_url_login = g_baseurl+'content/telebank-client-mobile/ru/login.touch.html',
	g_url_product_select = g_baseurl+'content/telebank-client-mobile/ru/login/telebank/product-details/_jcr_content.product-select.html',
	g_url_product_details = g_baseurl+'content/telebank-client-mobile/ru/login/telebank/product-details.touch.html',
	g_headers = {
		'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
		'Accept-Charset': 'windows-1251,utf-8;q=0.7,*;q=0.3',
		'Accept-Language': 'ru-RU,ru;q=0.8,en-US;q=0.6,en;q=0.4',
		'Cache-Control': 'no-cache',
		'Connection': 'keep-alive',
		'User-Agent': 'Mozilla/5.0 (Windows NT 6.1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/29.0.1547.76 Safari/537.36',
		'Pragma': 'no-cache',
		//'Origin': 'https://mobile.vtb24.ru',
		'X-Requested-With': 'XMLHttpRequest'
		//'Referer': g_baseurl + 'content/telebank-client/ru/login.html'
	},
	g_preferences, g_pageToken, g_pageSecurityID, g_browserSessionUid;

function main() {
	g_preferences = ZenMoney.getPreferences();
	if (!g_preferences.login) throw new ZenMoney.Error("Введите логин в интернет-банк!", null, true);
	if (!g_preferences.password) throw new ZenMoney.Error("Введите пароль в интернет-банк!", null, true);

	var json = login();
	//ZenMoney.trace('JSON после входа: '+ JSON.stringify(json));

	processAccounts(json);

	ZenMoney.trace('Запрашиваем данные по операциям...');
	processTransactions();

	ZenMoney.setResult({success: true});
}

function login(){
	//var html = ZenMoney.requestGet(g_baseurl + 'content/telebank-client/ru/login.html', g_headers);
	var html = ZenMoney.requestGet(g_url_login, g_headers);
	g_pageSecurityID = getParam(html, /page-security-id="([^"]*)/i, null, html_entity_decode);
	//ZenMoney.trace('pageSecurityId: '+g_pageSecurityID);

	g_browserSessionUid = guid();

	var isAlreadyAuthorized = getParamByName(html, 'isMinervaUserAuthenticated');
	//ZenMoney.trace('isAlreadyAuthorized: '+ isAlreadyAuthorized);

	ZenMoney.trace('Пытаемся войти...');
	var dt = new Date(), dtStr = dt.getHours() + ":" + dt.getMinutes() + ":" + dt.getSeconds() + " " + dt.getDate() + "-" + dt.getMonth() + "-" + dt.getFullYear();
	var json = requestJson('services/signin', null, {
		post: {
			login: g_preferences.login,
			password: g_preferences.password,
			isMobile: true,
			_charset_: 'utf-8',
			dateTime: dtStr
		},
		noException: true
	}, addHeaders({Referer: g_baseurl + 'content/telebank-client/ru/login.html'}));

	g_pageToken = json.pageToken;
	//ZenMoney.trace('JSON: '+ JSON.stringify(json));

	// проверим, не авторизированы ли уже
	/*if (isAlreadyAuthorized == 'true'){
		ZenMoney.trace('Уже авторизированы. Используем текущую сессию.');

		// ToDO: корректно завершать авторизацию, чтобы при повторном входе можно было воспользоваться текущей сессией
		return;
	}*/

	if (!json.authorized) {
		if (json.accountLocked)
			throw new ZenMoney.Error('Ваш аккаунт заблокирован банком, свяжитесь со службой технической поддержки для разблокирования аккаунта.', null, true);

		if (json.error && json.error.msg) {
			var error = json.error.msg;
			if (error)
				throw new ZenMoney.Error(error, null, /Логин или пароль введены неверно/i.test(error));
		}

		if (json.authConfirmation) {
			ZenMoney.trace('Необходимо ввести SMS-код для входа. Запрашиваем новый код...');
			json = requestJson("services/signin", null, {
				post: {
					action: 'challenge'
				},
				noException: true
			});
			//ZenMoney.trace('JSON: '+ JSON.stringify(json));

			var smsCode = ZenMoney.retrieveCode("Введите код авторизации из СМС для входа в ВТБ24-Онлайн", null, {
				inputType: "number",
				time: 18E4
			});
			ZenMoney.trace("СМС-код получен.");

			json = requestJson('services/signin', null, {
				post: {
					action: 'completeLogon',
					isMobile: true,
					challengeResponse: smsCode
				},
				noException: true
			});

			//ZenMoney.trace("JSON: "+ JSON.stringify(json));
			if (json.error) {
				error = json.error.msg;
				if (error)
					throw new ZenMoney.Error(error, null, /Неверный SMS/i.test(error));
			}

			g_pageToken = json.pageToken;
			ZenMoney.trace("Успешно вошли.");
		}

		if (!json.authorized)
			throw new ZenMoney.Error('Не удалось зайти в ВТБ24-Онлайн. Сайт изменен?');
	}
	else
		ZenMoney.trace('Уже авторизованы. Продолжаем...');

	return json;
}

var g_accounts = []; // линки активных счетов, по ним фильтруем обработку операций

function processAccounts(json) {
	ZenMoney.trace('Инициализация...');

	// открываем список счетов
	json = requestJson('processor/process/minerva/action', null, {
		post: {
			components: JSON.stringify([{
				componentId: "MobileAccountsAndCardsHomepage",
				actions: [{
					actionId: "PORTFOLIOS",
					params: {
						portfolioId: "AccountsAndCards",
						isMobile: "true"
					},
					partialResult: true,
					requestId:"8"
				}]
			}]),
			pageInstanceUid: g_browserSessionUid+'.1',
			callId: 2,
			pageSecurityID: g_pageSecurityID,
			pageToken: g_pageToken
		}
	}, addHeaders({Referer: g_url_login}));

	// загружаем список счетов
	json = requestJson('processor/process/minerva/operation', null, {
		post: {
			action: 'checkAvailability',
			serviceData: 'telebank|RequestCallbackInitData|RequestCallbackScenario',
			callId: 1,
			pageSecurityID: g_pageSecurityID,
			pageToken: g_pageToken
		}
	}, addHeaders({ Referer: g_url_login }));
	//ZenMoney.trace('1. JSON checkAvailability: '+ JSON.stringify(json));

	g_pageToken = json.pageToken;

	json = requestJson('processor/process/minerva/action', null, {
		post: {
			components: JSON.stringify([
				{
					"componentId" : "SideMenuComponent",
					"actions" : [{
						"actionId" : "REGISTERED_CALLBACK_REQUEST",
						"requestId" : "1"
					}
					]
				}, {
					"componentId" : "MOBILENOTIFICATIONS",
					"actions" : [{
						"actionId" : "NOTIFICATIONS",
						"params" : {
							"allNotificationsRequired" : true
						},
						"permanent" : true,
						"requestId" : "2"
					}, {
						"actionId" : "PERSONAL_OFFERS",
						"params" : {
							"getIncomeParams" : {
								"isPdaNotifications" : true
							}
						},
						"requestId" : "3"
					}
					]
				}, {
					"componentId" : "COMPLEX_SERVICE_CONTRACT_TOPIC",
					"actions" : [{
						"actionId" : "COMPLEX_SERVICE_CONTRACT",
						"params" : {},
						"requestId" : "4"
					}
					]
				}, {
					"componentId" : "PRODUCT_LIST",
					"actions" : [{
						"actionId" : "PORTFOLIOS",
						"params" : {
							"portfolioId" : "AccountsAndCards",
							"forProductPage" : "true"
						},
						"requestId" : "5"
					}
					]
				}, {
					"componentId" : "mobileHomePageTransactions",
					"actions" : [{
						"actionId" : "TRANSACTIONS",
						"params" : {
							"numberOfTransactions" : "5"
						},
						"requestId" : "6"
					}
					]
				}, {
					"componentId" : "CacheTokenComponent",
					"actions" : [{
						"actionId" : "CACHE_TOKENS",
						"permanent" : true,
						"requestId" : "7"
					}
					]
				}
				]
			),
			pageInstanceUid: g_browserSessionUid+'.1',
			callId: 2,
			pageSecurityID: g_pageSecurityID,
			pageToken: g_pageToken
		}
	}, addHeaders({ Referer: g_url_login }));
	ZenMoney.trace('JSON списка счетов: '+ JSON.stringify(json));

	var accounts = getJsonObjectById(json, 'MobileAccountsAndCardsHomepage', 'PORTFOLIOS').result.items[0].products;
	var accDict = [];
	for(var a=0; a<accounts.length; a++){
		var account = accounts[a];

		switch (account.id)
		{
			case 'MasterAccountProduct':
				for(iGr=0; iGr<account.groups.length; iGr++){
					group = account.groups[iGr];

					for(iItem=0; iItem<group.items.length; iItem++) {
						item = group.items[iItem];
						if (!item.hasOwnProperty('number')) continue;

						acc = {
							id: item.id,
							title: item.displayName,
							type: 'ccard',
							syncID: [ item.number.substr(5, 3) + item.number.substr(-3) ], // в синнкайди добавляем и код валюты, чтобы исключить повторения
							instrument: getInstrument(item.amount.currency),
							balance: item.amount.sum
						};

						ZenMoney.trace('Добавляем мастер счёт: '+ acc.title +' (#'+ acc.id +')');

						// проверим нет ли карт, прикреплённых к мастер счёту
						if (item.hasOwnProperty('items'))
							for(var i=0; i<item.items.length; i++)
								acc.syncID.push(item.items[i].number.substr(-4));

						accDict.push(acc);
						g_accounts[acc.id] = {
							id: acc.id,
							title: acc.title,
							type: 'MasterAccount'
						};
					}
				}
				break;

			case 'DebitCardProduct':
			case 'CreditCardProduct':
				for(iGr=0; iGr<account.groups.length; iGr++){
					group = account.groups[iGr];

					for(iItem=0; iItem<group.items.length; iItem++) {
						item = group.items[iItem];
						if (!item.hasOwnProperty('number')) continue;

						acc = {
							id: item.id,
							title: item.displayName,
							type: 'ccard',
							syncID: item.number.substr(-4),
							instrument: getInstrument(item.amount.currency),
							balance: item.amount.sum
						};

						ZenMoney.trace('Добавляем карту: '+ acc.title +' (#'+ acc.id +')');

						accDict.push(acc);
						g_accounts[acc.id] = {
							id: acc.id,
							title: acc.title,
							type: 'CreditCard'
						};
					}
				}
				break;
		}
	}

	ZenMoney.trace('Всего счетов добавлено: '+ accDict.length);
	ZenMoney.trace('JSON: '+ JSON.stringify(accDict));
	ZenMoney.addAccount(accDict);
}

function processTransactions() {
	var browserId = 2;
	for(var accId in g_accounts) {
		var acc = g_accounts[accId];
		browserId++;

		ZenMoney.trace('Загружаем "' + acc.title + '" (#' + accId + ')');

		var lastSyncTime = ZenMoney.getData('last_sync_' + accId, 0);

		// первоначальная инициализация
		if (!lastSyncTime || lastSyncTime == 0) {
			// по умолчанию загружаем операции за неделю
			var period = !g_preferences.hasOwnProperty('period') || isNaN(period = parseInt(g_preferences.period)) ? 7 : period;

			if (period > 100) period = 100;	// на всякий случай, ограничим лимит, а то слишком долго будет

			lastSyncTime = Date.now() - period * 24 * 60 * 60 * 1000;
		}

		// всегда захватываем одну неделю минимум
		lastSyncTime = Math.min(lastSyncTime, Date.now() - 7 * 24 * 60 * 60 * 1000);
		var lastSyncDate = new Date(lastSyncTime);
		var nowSyncDate = new Date();
		var startDate = n2(lastSyncDate.getDate()) + '.' + n2(lastSyncDate.getMonth() + 1) + '.' + lastSyncDate.getFullYear();
		var endDate = n2(nowSyncDate.getDate()) + '.' + n2(nowSyncDate.getMonth() + 1) + '.' + nowSyncDate.getFullYear();

		ZenMoney.trace('Запрашиваем операции с ' + lastSyncDate.toLocaleString());

		json = requestJson('processor/process/minerva/operation', null, {
			post: {
				action: 'checkAvailability',
				serviceData: 'telebank|RequestCallbackInitData|RequestCallbackScenario',
				callId: 1,
				pageSecurityID: g_pageSecurityID,
				pageToken: g_pageToken
			}
		}, addHeaders({Referer: g_url_login}));

		g_pageToken = json.pageToken;

		json = requestJson('processor/process/minerva/action', null, {
			post: {
				components: JSON.stringify([
					{
						"componentId": "SideMenuComponent",
						"actions": [{
							"actionId": "REGISTERED_CALLBACK_REQUEST",
							"requestId": "1"
						}
						]
					}, {
						"componentId": "MOBILENOTIFICATIONS",
						"actions": [{
							"actionId": "NOTIFICATIONS",
							"params": {
								"allNotificationsRequired": true
							},
							"permanent": true,
							"requestId": "2"
						}, {
							"actionId": "PERSONAL_OFFERS",
							"params": {
								"getIncomeParams": {
									"isPdaNotifications": true
								}
							},
							"requestId": "3"
						}
						]
					}, {
						"componentId": "productsStatement",
						"actions": [{
							"actionId": "STATEMENT",
							"params": {
								"products": [{
									"id": accId,
									"className": acc.type,
									"number": "",
									"dateCreation": ""
								}
								],
								"startDate": startDate,
								"endDate": endDate
							},
							"requestId": "4"
						}
						]
					}, {
						"componentId": "CacheTokenComponent",
						"actions": [{
							"actionId": "CACHE_TOKENS",
							"permanent": true,
							"requestId": "5"
						}
						]
					}
				]),
				pageInstanceUid: g_browserSessionUid + '.' + browserId,
				callId: 2,
				pageSecurityID: g_pageSecurityID,
				pageToken: g_pageToken
			}
		}, addHeaders({Referer: g_url_login}));
		ZenMoney.trace('1. JSON списка операций: ' + JSON.stringify(json));

		pageToken = json.pageToken;

		json = requestJson('processor/process/minerva/action', null, {
			post: {
				components: '[]',
				pageInstanceUid: g_browserSessionUid + '.' + browserId,
				callId: 3,
				pageSecurityID: g_pageSecurityID,
				pageToken: g_pageToken
			}
		}, addHeaders({Referer: g_url_login}));
		ZenMoney.trace('2. JSON списка операций: ' + JSON.stringify(json));

		g_pageToken = pageToken;

		var tranDict = [];
		var transactionItems = [];
		var prodStat = getJsonObjectById(json, 'productsStatement', 'STATEMENT');

		// ждём ответа по транзакциям, если не пришли сразу
		if (!prodStat)
			for (var k=0; k<5; k++) {
				json = requestJson('processor/process/minerva/action', null, {
					post: {
						components: '[]',
						pageInstanceUid: g_browserSessionUid + '.' + browserId,
						callId: 4+k,
						pageSecurityID: g_pageSecurityID,
						pageToken: pageToken
					}
				}, addHeaders({Referer: g_url_login}));
				ZenMoney.trace((3+k)+'. JSON списка операций: ' + JSON.stringify(json));

				prodStat = getJsonObjectById(json, 'productsStatement', 'STATEMENT');
				if (prodStat)
					break;
			}

		if (prodStat && prodStat.hasOwnProperty('result') && prodStat.result.hasOwnProperty('items'))
			transactionItems = prodStat.result.items;

		// обрабатываем и добавляем операции
		if (transactionItems.length > 0) {
			var transactions = transactionItems[0].transactions;
			ZenMoney.trace('JSON transactions: ' + JSON.stringify(transactions));

			for (var iTran = 0; iTran < transactions.length; iTran++) {
				var t = transactions[iTran];

				// учитываем только успешные операции
				if (t.failed == "false")
					continue;

				var tran = {};
				ZenMoney.trace('Добавляем операцию #' + iTran + ': ' + t.displayedDate + ' - ' + t.details);

				tran.id = t.id;
				tran.date = t.transactionDate;
				
				var sum = t.amount.sum;
				var curr = getInstrument(t.amount.currency);
				if (sum > -0.01 && sum < 0.01) continue; // предохранитель

				if (sum < 0) {
					tran.income = 0;
					tran.incomeAccount = acc.id;
					tran.outcome = -sum;
					tran.outcomeAccount = acc.id;
				} else {
					tran.income = sum;
					tran.incomeAccount = acc.id;
					tran.outcome = 0;
					tran.outcomeAccount = acc.id;
				}

				if (t.details.indexOf("нятие в ") > 0 || t.details.indexOf("ополнение в ") > 0){
					// операции наличными
					if (sum > 0) {
						tran.outcome = sum;
						tran.outcomeAccount = "cash#"+curr;
					} else {
						tran.income = -sum;
						tran.incomeAccount = "cash#"+curr;
					}

					tran.comment = t.details;
				}
				else
				{
					switch (acc.type){
						case 'MasterAccount':
							if (retail = /^Операция п.*?\d+\.\s+(.+?)(?:\s+[а-яА-Я].*)?$/.exec(t.details))
								tran.payee = retail[1];
							break;

						case 'CreditCard':
							if (retail = /^[\dX]+\s+Retail\s+(.+)/.exec(t.details))
								tran.payee = retail[1];
							break;
					}

					if (!tran.hasOwnProperty('payee') || !tran.payee)
						tran.comment = t.order && t.order.description ? t.order.description.trim() : t.details.trim();
				}

				tranDict.push(tran);
			}
		}

		ZenMoney.trace('Всего операций добавлено: ' + tranDict.length);
		ZenMoney.trace('JSON: ' + JSON.stringify(tranDict));
		ZenMoney.addTransaction(tranDict);
	}
}

function clearHtml(html) {
	if (!html)
		return '--- undefined ---';

	if (typeof html != 'string')
		return '--- not string ---';

	//html = getParam(html, /<section[^>]*id="pageContainer"[\s\S]*?\/section>/i);

	return html.replaceAll(
		[	/<head[\s\S]+?\/head>/g, '',
			/<script[\s\S]+?\/script>/g, '',
			/<noscript[\s\S]+?\/noscript>/ig, '',
			/ +[\r\n]+/g, '\r\n',
			/[\r\n]+/g, '\r\n'
		]);
}

function getInstrument(currency){
	switch (currency){
		case '₽': return 'RUB';
		case '$': return 'USD';
		case '€': return 'EUR';
		default:
			throw new ZenMoney.Error("Обнаружена не обрабатываемая валюта '"+currency+"'");
	}
	return currency;
}

function getJsonObjectById(json, componentId, resultActionId){
	if (!componentId)
		return json;

	if (!json.components) {
		ZenMoney.trace("В ответе банка не найден компонент " + componentId + ": " + JSON.stringify(json));
		throw new ZenMoney.Error("Ошибка распознавания ответа от банка. Возможно, изменилась структура интернет-банка. Обратитесь к разработчикам.");
	}

	var components = json.components;
	for(var i=0; i<components.length; i++){
		var component = components[i];
		if (!component.componentId || component.componentId != componentId) continue;
		if (!resultActionId) return component;

		var results = component.results;
		for(var r=0; r<results.length; r++){
			var result = results[r];
			if (!result.actionId || result.actionId != resultActionId) continue;
			return result;
		}

		ZenMoney.trace("В ответе банка не найден объект "+componentId+"."+resultActionId+" : "+ JSON.stringify(json));
		throw new ZenMoney.Error("Ошибка распознавания ответа от банка. Возможно, изменилась структура интернет-банка. Обратитесь к разработчикам.");
	}
}

function getRedirect(url) {
	if (url.substr(0, 1) == '/') url = url.substr(1);
	if (url.substr(0, 4) == 'http') return url;
	return g_baseurl + url;
}

function getJson(html) {
	try {
		return JSON.parse(html);
	} catch (e) {
		ZenMoney.trace('Bad json (' + e.message + '): ' + html);
		throw new ZenMoney.Error('Сервер вернул ошибочные данные: ' + e.message);
	}
}

function requestJson(requestCode, data, parameters, headers) {
	var params = [];
	parameters || (parameters = {});

	if (data)
		for (var d in data) params.push(encodeURIComponent(d) + "=" + encodeURIComponent(data[d]));
	/*params.push(encodeURIComponent("appVersion") + "=" + encodeURIComponent("3.1.0"));
	params.push(encodeURIComponent("platform") + "=" + encodeURIComponent("android"));
	params.push(encodeURIComponent("origin") + "=" + encodeURIComponent("mobile,ib5,loyalty"));*/

	if (parameters.post)
		data = ZenMoney.requestPost(g_baseurl + requestCode + "?" + params.join("&"), parameters.post, headers || g_headers);
	else {
		if (parameters) for (var k in parameters) params.push(encodeURIComponent(k) + "=" + encodeURIComponent(parameters[k]));
		data = ZenMoney.requestGet(g_baseurl + requestCode + "?" + params.join("&"), headers || g_headers);
	}

	data = getJson(data);

	if (data.status && data.status != "OK" && !parameters.noException) {
		ZenMoney.trace('Ошибка запроса данных. Получено: '+ JSON.stringify(data));
		var error = ', '+data.errorMessage || '';
		ZenMoney.trace("Ошибка при запросе данных: " + requestCode + error)
		throw new ZenMoney.Error((parameters.scope ? parameters.scope + ": " : "") + (data.plainMessage || data.errorMessage));
	}

	return data;
}

function in_array(needle, haystack) {
	var length = haystack.length;
	for(var i = 0; i < length; i++) {
		if(haystack[i] == needle) return true;
	}
	return false;
}

function guid() {
	function s4() {
		return Math.floor((1 + Math.random()) * 0x10000)
			.toString(16)
			.substring(1);
	}
	return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
		s4() + '-' + s4() + s4() + s4();
}
